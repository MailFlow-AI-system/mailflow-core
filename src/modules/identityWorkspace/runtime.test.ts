import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { createIdentityWorkspaceRuntime, startIdentityWorkspaceWorker } from './index.js'
import { createAuth } from './infrastructure/auth/createAuth.js'
import { assertOnboardingDatabaseRole } from './onboarding/databaseRole.js'
import { assertWorkspaceDatabaseRole } from './workspaces/databaseRole.js'
import { assertWorkspaceSelectionDatabaseRole } from './workspaces/selectionDatabaseRole.js'

vi.mock('./infrastructure/auth/createAuth.js', () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: async () => null },
    handler: async () => Response.json(null),
  })),
}))
vi.mock('./workspaces/databaseRole.js', () => ({ assertWorkspaceDatabaseRole: vi.fn() }))
vi.mock('./workspaces/selectionDatabaseRole.js', () => ({
  assertWorkspaceSelectionDatabaseRole: vi.fn(),
}))
vi.mock('./onboarding/databaseRole.js', () => ({ assertOnboardingDatabaseRole: vi.fn() }))

const pool = new Pool()
const authConfig = {
  secret: 'runtime-test-secret-at-least-32-characters',
  baseURL: 'http://127.0.0.1:8080',
  siteURL: 'http://localhost:4321',
  webAppURL: 'http://localhost:3003',
  allowedOrigins: ['http://localhost:4321', 'http://localhost:3003'],
  appEnv: 'development' as const,
  resend: { apiKey: 'no-external-delivery', from: 'noreply@mailflow.invalid' },
}
const dependencies = { pool, database: drizzle(pool), authConfig, sendAccountEmail: async () => {} }
afterEach(() => vi.clearAllMocks())

it('keeps workspace capabilities dark by default without requiring workspace database privileges', async () => {
  const runtime = await createIdentityWorkspaceRuntime({ ...dependencies, environment: {} })
  expect(runtime.auth).toBe(vi.mocked(createAuth).mock.results[0]?.value)
  expect(runtime.allowedAuthOrigins).toEqual(authConfig.allowedOrigins)
  expect(runtime.mailWorkspaceAuthority?.resolve).toBeTypeOf('function')
  expect(runtime.workspaces).toBeUndefined()
  expect(runtime.onboarding).toBeUndefined()
  expect(assertWorkspaceDatabaseRole).not.toHaveBeenCalled()
})

it('rejects inconsistent rollout before constructing auth or checking privileges', async () => {
  for (const environment of [
    { APP_ENV: 'development', WORKSPACE_SWITCHING_ENABLED: 'true' },
    // Switching needs the workspace hosting configuration, which this legacy config lacks.
    {
      APP_ENV: 'development',
      WORKSPACE_READ_ENABLED: 'true',
      WORKSPACE_SWITCHING_ENABLED: 'true',
    },
    { WORKSPACE_SIGNUP_CUTOVER_ENABLED: 'true' },
    {
      WORKSPACE_ONBOARDING_ENABLED: 'true',
      WORKSPACE_WEB_BASE_ORIGIN: 'http://workspace.test/path',
    },
  ]) {
    await expect(createIdentityWorkspaceRuntime({ ...dependencies, environment })).rejects.toThrow()
  }
  expect(createAuth).not.toHaveBeenCalled()
  expect(assertWorkspaceDatabaseRole).not.toHaveBeenCalled()
})

it('assembles authorized reads and workspace handoff only after both privilege checks', async () => {
  const runtime = await createIdentityWorkspaceRuntime({
    ...dependencies,
    authConfig: {
      ...authConfig,
      allowedOrigins: [authConfig.siteURL],
      workspaceDeployment: { baseHost: 'localhost', webOrigin: 'http://localhost:3003' },
    },
    environment: {
      APP_ENV: 'development',
      WORKSPACE_READ_ENABLED: 'true',
      WORKSPACE_SWITCHING_ENABLED: 'true',
    },
  })
  expect(assertWorkspaceDatabaseRole).toHaveBeenCalledWith(pool)
  expect(assertWorkspaceSelectionDatabaseRole).toHaveBeenCalledWith(pool)
  expect(runtime.workspaces?.reader.context).toBeTypeOf('function')
  const provisioning = vi.mocked(createAuth).mock.calls[0]?.[4]
  expect(provisioning?.workspaceHandoff?.issue).toBeTypeOf('function')
  expect(provisioning?.workspaceHandoff?.consume).toBeTypeOf('function')
  expect(provisioning?.accountWorkspace).toBeTypeOf('function')
  expect(vi.mocked(assertWorkspaceSelectionDatabaseRole).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(createAuth).mock.invocationCallOrder[0] ?? 0,
  )
})

it('assembles cutover with protected OTP storage and the exact signup origin', async () => {
  const runtime = await createIdentityWorkspaceRuntime({
    ...dependencies,
    environment: {
      WORKSPACE_ONBOARDING_ENABLED: 'true',
      WORKSPACE_SIGNUP_CUTOVER_ENABLED: 'true',
      WORKSPACE_WEB_BASE_ORIGIN: 'http://localhost:3003',
    },
  })
  expect(assertOnboardingDatabaseRole).toHaveBeenCalledWith(pool)
  expect(runtime.onboarding?.allowedOrigin).toBe(authConfig.siteURL)
  expect(runtime.onboarding?.closeLegacySignup).toBe(true)
  const storage = vi.mocked(createAuth).mock.calls[0]?.[4]?.otpStorage
  expect(storage).toBeDefined()
  const ciphertext = await storage?.encrypt('123456')
  expect(ciphertext).not.toContain('123456')
  expect(await storage?.decrypt(ciphertext ?? '')).toBe('123456')
  expect(vi.mocked(createAuth).mock.calls[0]?.[4]?.workspaceHandoff).toBeUndefined()
})

it('fails closed before constructing auth if a required database role is unsafe', async () => {
  vi.mocked(assertWorkspaceSelectionDatabaseRole).mockRejectedValueOnce(
    new Error('unsafe database role'),
  )
  await expect(
    createIdentityWorkspaceRuntime({
      ...dependencies,
      authConfig: {
        ...authConfig,
        workspaceDeployment: { baseHost: 'localhost', webOrigin: 'http://localhost:3003' },
      },
      environment: {
        APP_ENV: 'development',
        WORKSPACE_READ_ENABLED: 'true',
        WORKSPACE_SWITCHING_ENABLED: 'true',
      },
    }),
  ).rejects.toThrow('unsafe database role')
  expect(createAuth).not.toHaveBeenCalled()
})

it('does not load auth credentials or start delivery when the worker gate is disabled', async () => {
  const worker = await startIdentityWorkspaceWorker({
    environment: {},
    pool,
    signal: new AbortController().signal,
    report: vi.fn(),
  })
  expect(worker).toEqual({ enabled: false, completion: undefined })
  expect(assertOnboardingDatabaseRole).not.toHaveBeenCalled()
})

it('rejects delivery before starting the worker when its database role is unsafe', async () => {
  vi.mocked(assertOnboardingDatabaseRole).mockRejectedValueOnce(new Error('unsafe database role'))
  await expect(
    startIdentityWorkspaceWorker({
      pool,
      environment: {
        WORKSPACE_EMAIL_DELIVERY_ENABLED: 'true',
        BETTER_AUTH_SECRET: authConfig.secret,
        BETTER_AUTH_URL: authConfig.baseURL,
        SITE_URL: authConfig.siteURL,
        WEB_APP_URL: authConfig.webAppURL,
        RESEND_API_KEY: authConfig.resend.apiKey,
        RESEND_FROM_EMAIL: authConfig.resend.from,
      },
      signal: new AbortController().signal,
      report: vi.fn(),
    }),
  ).rejects.toThrow('unsafe database role')
})
