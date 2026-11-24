import { OpenAPIHono } from '@hono/zod-openapi'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createIdentityWorkspaceRuntime, startIdentityWorkspaceWorker } from './index.js'
import { loadAuthConfig } from './infrastructure/auth/authConfig.js'
import { installAuthRoutes } from './infrastructure/auth/route.js'
import { testClientIp } from './onboarding/utils/testClientIp.test-support.js'
import { createWorkspaceTestFixture } from './workspaces/fixtures.test-support.js'

describe('identity/workspace runtime with real PostgreSQL privileges', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceTestFixture>>
  beforeAll(async () => {
    fixture = await createWorkspaceTestFixture()
  })
  afterAll(async () => {
    await fixture?.close()
  })

  it('authenticates a workspace host with a host-only cookie and hands off to another host', async () => {
    const environment = {
      APP_ENV: 'staging',
      WORKSPACE_READ_ENABLED: 'true',
      WORKSPACE_SWITCHING_ENABLED: 'true',
      WORKSPACE_WEB_BASE_ORIGIN: 'https://staging.example.com',
      BETTER_AUTH_URL: 'https://api-staging.example.com',
      SITE_URL: 'https://site-staging.example.com',
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
    const origin = `https://${fixture.acmeSlug}.staging.example.com`
    const target = `https://${fixture.northwindSlug}.staging.example.com`
    const app = new OpenAPIHono()
    installAuthRoutes(app, {
      auth: runtime.auth,
      allowedOrigins: runtime.allowedAuthOrigins,
      ...(runtime.isAllowedAuthOrigin ? { isAllowedOrigin: runtime.isAllowedAuthOrigin } : {}),
    })
    const post = (path: string, source: string | undefined, body: unknown, cookie = '') =>
      app.request(
        new Request(`${authConfig.baseURL}/api/auth${path}`, {
          method: 'POST',
          headers: {
            ...(source ? { Origin: source } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            'Content-Type': 'application/json',
            'x-real-ip': testClientIp(),
          },
          body: JSON.stringify(body),
        }),
      )
    for (const source of [
      undefined,
      'https://staging.example.com',
      'https://app-staging.example.com',
      `https://${fixture.acmeSlug}.production.example.com`,
      `${origin}.attacker.com`,
    ]) {
      const rejectedLogin = await post('/sign-in/email', source, {
        email: fixture.email,
        password: fixture.password,
      })
      expect(rejectedLogin.status).toBe(403)
      expect(rejectedLogin.headers.get('set-cookie')).toBeNull()
    }
    const login = await post('/sign-in/email', origin, {
      email: fixture.email,
      password: fixture.password,
    })
    expect(login.status).toBe(200)
    const setCookies = login.headers.getSetCookie().join(';')
    expect(setCookies).toContain('__Secure-better-auth.session_token=')
    expect(setCookies).not.toMatch(/Domain=/i)
    expect(setCookies).toContain('Secure')
    expect(setCookies).toContain('HttpOnly')
    expect(setCookies).toContain('SameSite=Lax')
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')

    const issued = await post(
      '/workspace-handoff/issue',
      origin,
      {
        workspaceId: fixture.northwind,
      },
      cookie,
    )
    expect(issued.status).toBe(200)
    expect(issued.headers.get('access-control-allow-origin')).toBe(origin)
    expect(issued.headers.get('cache-control')).toContain('no-store')
    const handoff = new URL(((await issued.json()) as { url: string }).url)
    expect(handoff.origin).toBe(target)
    const exchanged = await post('/workspace-handoff/exchange', target, {
      code: handoff.searchParams.get('code'),
    })
    expect(exchanged.status).toBe(200)
    expect(exchanged.headers.getSetCookie().join(';')).not.toMatch(/Domain=/i)
    expect(
      (await post('/workspace-handoff/issue', origin, { workspaceId: fixture.globex }, cookie))
        .status,
    ).toBe(404)

    const logout = await post('/sign-out', origin, {}, cookie)
    expect(logout.status).toBe(200)
    expect(logout.headers.getSetCookie().join(';')).not.toMatch(/Domain=/i)
    expect(
      await runtime.auth.api.getSession({ headers: new Headers({ Cookie: cookie }) }),
    ).toBeNull()
  })

  it('composes workspace hosting and authorized workspace capabilities through the public interface', async () => {
    const environment = {
      APP_ENV: 'development',
      WORKSPACE_READ_ENABLED: 'true',
      WORKSPACE_SWITCHING_ENABLED: 'true',
      WORKSPACE_ONBOARDING_ENABLED: 'true',
      WORKSPACE_SIGNUP_CUTOVER_ENABLED: 'true',
      WORKSPACE_WEB_BASE_ORIGIN: 'http://workspace.test:3001',
      BETTER_AUTH_URL: fixture.authConfig.baseURL,
      SITE_URL: fixture.authConfig.siteURL,
      BETTER_AUTH_SECRET: fixture.authConfig.secret,
      RESEND_API_KEY: 'no-external-delivery',
      RESEND_FROM_EMAIL: 'noreply@mailflow.invalid',
    }
    const authConfig = loadAuthConfig(environment)
    const runtime = await createIdentityWorkspaceRuntime({
      environment,
      pool: fixture.pool,
      database: drizzle(fixture.pool),
      authConfig,
      sendAccountEmail: async () => {},
    })
    const login = await runtime.auth.handler(
      new Request(`${authConfig.baseURL}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: `http://${fixture.acmeSlug}.workspace.test:3001`,
        },
        body: JSON.stringify({ email: fixture.email, password: fixture.password }),
      }),
    )
    expect(login.status).toBe(200)
    expect(login.headers.get('set-cookie')).not.toMatch(/Domain=/i)
    const page = await runtime.workspaces?.reader.list(fixture.userId)
    expect(page?.items.map((workspace) => workspace.id).sort()).toEqual(
      [fixture.acme, fixture.northwind].sort(),
    )
    expect(await runtime.workspaces?.reader.context(fixture.userId, fixture.globexSlug)).toBeNull()
    expect(runtime.onboarding?.closeLegacySignup).toBe(true)
  })

  it.each([
    { WORKSPACE_READ_ENABLED: 'true' },
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
      WEB_APP_URL: 'http://localhost:3001',
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
