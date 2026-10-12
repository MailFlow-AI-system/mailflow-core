import { OpenAPIHono } from '@hono/zod-openapi'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createIdentityWorkspaceRuntime, startIdentityWorkspaceWorker } from './index.js'
import { loadAuthConfig } from './infrastructure/auth/authConfig.js'
import { installAuthRoutes } from './infrastructure/auth/route.js'
import { testClientIp } from './onboarding/utils/testClientIp.test-support.js'
import { createWorkspaceTestFixture } from './workspaces/fixtures.test-support.js'
import { createWorkspaceSelectionRoutes } from './workspaces/selectionRoute.js'

describe('identity/workspace runtime with real PostgreSQL privileges', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceTestFixture>>
  beforeAll(async () => {
    fixture = await createWorkspaceTestFixture()
  })
  afterAll(async () => {
    await fixture?.close()
  })

  it('authenticates a remote HTTPS tenant, shares a secure cookie, selects and resumes with real RLS', async () => {
    const environment = {
      APP_ENV: 'staging',
      WORKSPACE_READ_ENABLED: 'true',
      WORKSPACE_SWITCHING_ENABLED: 'true',
      WORKSPACE_WEB_BASE_ORIGIN: 'https://app.staging.example.com',
      BETTER_AUTH_URL: 'https://api.staging.example.com',
      WEB_APP_URL: 'https://app.staging.example.com',
      SITE_URL: 'https://site.staging.example.com',
      BETTER_AUTH_SECRET: fixture.authConfig.secret,
      RESEND_API_KEY: 'no-external-delivery',
      RESEND_FROM_EMAIL: 'noreply@mailflow.invalid',
    }
    const authConfig = loadAuthConfig(environment)
    const runtime = await createIdentityWorkspaceRuntime({
      environment,
      authConfig,
      pool: fixture.pool,
      database: drizzle(fixture.pool),
      sendAccountEmail: async () => {},
    })
    const origin = `https://${fixture.acmeSlug}.app.staging.example.com`
    for (const source of [
      undefined,
      'https://acme.app.production.example.com',
      `${origin}.attacker.com`,
    ]) {
      const rejectedLogin = await runtime.auth.handler(
        new Request(`${authConfig.baseURL}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: {
            ...(source ? { Origin: source } : {}),
            'Content-Type': 'application/json',
            'x-real-ip': testClientIp(),
          },
          body: JSON.stringify({ email: fixture.email, password: fixture.password }),
        }),
      )
      expect(rejectedLogin.status).toBe(403)
      expect(rejectedLogin.headers.get('set-cookie')).toBeNull()
    }
    const login = await runtime.auth.handler(
      new Request(`${authConfig.baseURL}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'x-real-ip': testClientIp(),
        },
        body: JSON.stringify({ email: fixture.email, password: fixture.password }),
      }),
    )
    expect(login.status).toBe(200)
    const setCookies = login.headers.getSetCookie()
    expect(setCookies.join(';')).toContain('__Secure-better-auth.session_token=')
    expect(setCookies.join(';')).toContain('Domain=app.staging.example.com')
    expect(setCookies.join(';')).toContain('Secure')
    expect(setCookies.join(';')).toContain('HttpOnly')
    expect(setCookies.join(';')).toContain('SameSite=Lax')
    const cookie = setCookies.map((value) => value.split(';')[0]).join('; ')
    const app = new OpenAPIHono()
    installAuthRoutes(app, {
      auth: runtime.auth,
      allowedOrigins: runtime.allowedAuthOrigins,
      ...(runtime.isAllowedAuthOrigin ? { isAllowedOrigin: runtime.isAllowedAuthOrigin } : {}),
    })
    if (!runtime.workspaceSelection) throw new Error('Missing remote selection')
    app.route('/', createWorkspaceSelectionRoutes(runtime.workspaceSelection))
    const select = (source: string, workspaceId: string) =>
      app.request(
        new Request(`${authConfig.baseURL}/api/v1/workspace-selection`, {
          method: 'POST',
          headers: {
            Origin: source,
            Cookie: cookie,
            'Content-Type': 'application/json',
            'X-Workspace-Identity': fixture.userId,
          },
          body: JSON.stringify({ workspaceId }),
        }),
      )
    const selected = await select(origin, fixture.northwind)
    expect(selected.status).toBe(200)
    expect(selected.headers.get('access-control-allow-origin')).toBe(origin)
    expect(selected.headers.get('access-control-allow-credentials')).toBe('true')
    expect(await runtime.workspaceEntry?.reader.resolve(fixture.userId)).toMatchObject({
      source: 'preference',
      workspace: { id: fixture.northwind },
    })
    expect((await select(origin, fixture.globex)).status).toBe(404)
    expect((await select('https://acme.app.production.example.com', fixture.acme)).status).toBe(403)
    expect((await select(`${origin}.attacker.com`, fixture.acme)).status).toBe(403)
    const logout = await runtime.auth.handler(
      new Request(`${authConfig.baseURL}/api/auth/sign-out`, {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      }),
    )
    expect(logout.status).toBe(200)
    expect(logout.headers.getSetCookie().join(';')).toContain('Domain=app.staging.example.com')
    expect(
      await runtime.auth.api.getSession({ headers: new Headers({ Cookie: cookie }) }),
    ).toBeNull()
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
