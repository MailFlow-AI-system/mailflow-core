import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createIdentityWorkspaceRuntime, startIdentityWorkspaceWorker } from './index.js'
import { createWorkspaceTestFixture } from './workspaces/fixtures.test-support.js'

describe('identity/workspace runtime with real PostgreSQL privileges', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceTestFixture>>
  beforeAll(async () => {
    fixture = await createWorkspaceTestFixture()
  })
  afterAll(async () => {
    await fixture?.close()
  })

  it('composes shared-cookie auth and authorized workspace capabilities through the public interface', async () => {
    const runtime = await createIdentityWorkspaceRuntime({
      environment: {
        APP_ENV: 'development',
        WORKSPACE_READ_ENABLED: 'true',
        WORKSPACE_LOCAL_SWITCHING_ENABLED: 'true',
        WORKSPACE_ONBOARDING_ENABLED: 'true',
        WORKSPACE_SIGNUP_CUTOVER_ENABLED: 'true',
        WORKSPACE_WEB_BASE_ORIGIN: 'http://workspace.test:3001',
      },
      pool: fixture.pool,
      database: drizzle(fixture.pool),
      authConfig: fixture.authConfig,
      sendAccountEmail: async () => {},
    })
    const login = await runtime.auth.handler(
      new Request(`${fixture.authConfig.baseURL}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: fixture.authConfig.webAppURL },
        body: JSON.stringify({ email: fixture.email, password: fixture.password }),
      }),
    )
    expect(login.status).toBe(200)
    expect(login.headers.get('set-cookie')).toContain('Domain=workspace.test')
    const page = await runtime.workspaces?.reader.list(fixture.userId)
    expect(page?.items.map((workspace) => workspace.id).sort()).toEqual(
      [fixture.acme, fixture.northwind].sort(),
    )
    expect(await runtime.workspaces?.reader.context(fixture.userId, fixture.globexSlug)).toBeNull()
    expect(
      await runtime.workspaceSelection?.selection.select(fixture.userId, fixture.northwind),
    ).toMatchObject({ id: fixture.northwind })
    expect(
      await runtime.workspaceSelection?.selection.select(fixture.userId, fixture.globex),
    ).toBeNull()
    expect(await runtime.workspaceEntry?.reader.resolve(fixture.userId)).toMatchObject({
      source: 'preference',
      workspace: { id: fixture.northwind },
    })
    expect(runtime.onboarding?.closeLegacySignup).toBe(true)
  })

  it.each([
    { WORKSPACE_READ_ENABLED: 'true' },
    {
      APP_ENV: 'development',
      WORKSPACE_READ_ENABLED: 'true',
      WORKSPACE_LOCAL_SWITCHING_ENABLED: 'true',
    },
    {
      WORKSPACE_ONBOARDING_ENABLED: 'true',
      WORKSPACE_WEB_BASE_ORIGIN: 'http://workspace.test:3001',
    },
  ])(
    'rejects privileged database clients before exposing enabled capabilities (%j)',
    async (environment) => {
      await expect(
        createIdentityWorkspaceRuntime({
          environment,
          pool: fixture.admin,
          database: drizzle(fixture.admin),
          authConfig: fixture.authConfig,
          sendAccountEmail: async () => {},
        }),
      ).rejects.toThrow('non-owner role')
    },
  )

  it('uses the same database protection for the delivery worker and permits clean cancellation', async () => {
    const environment = {
      WORKSPACE_EMAIL_DELIVERY_ENABLED: 'true',
      BETTER_AUTH_SECRET: fixture.authConfig.secret,
      BETTER_AUTH_URL: fixture.authConfig.baseURL,
      SITE_URL: fixture.authConfig.siteURL,
      WEB_APP_URL: fixture.authConfig.webAppURL,
      RESEND_API_KEY: 'no-external-delivery',
      RESEND_FROM_EMAIL: 'noreply@mailflow.invalid',
    }
    const controller = new AbortController()
    controller.abort()
    await expect(
      startIdentityWorkspaceWorker({
        environment,
        pool: fixture.admin,
        signal: controller.signal,
        report: () => {},
      }),
    ).rejects.toThrow('non-owner role')
    const worker = await startIdentityWorkspaceWorker({
      environment,
      pool: fixture.pool,
      signal: controller.signal,
      report: () => {},
    })
    expect(worker.enabled).toBe(true)
    await expect(worker.completion).resolves.toBeUndefined()
  })
})
