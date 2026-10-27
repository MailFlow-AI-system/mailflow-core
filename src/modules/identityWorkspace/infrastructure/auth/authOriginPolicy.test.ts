import { Hono } from 'hono'
import { expect, it } from 'vitest'
import { loadAuthConfig } from './authConfig.js'
import { createAuthOriginPolicy, trustedAuthOrigins } from './authOriginPolicy.js'
import { createAuthOptions } from './createAuth.js'
import { installAuthRoutes } from './route.js'

const config = loadAuthConfig({
  APP_ENV: 'staging',
  BETTER_AUTH_SECRET: 'remote-workspace-secret-at-least-32-characters',
  BETTER_AUTH_URL: 'https://api.staging.example.com',
  SITE_URL: 'https://site.staging.example.com',
  WEB_APP_URL: 'https://app.staging.example.com',
  WORKSPACE_WEB_BASE_ORIGIN: 'https://app.staging.example.com',
  WORKSPACE_SWITCHING_ENABLED: 'true',
  WORKSPACE_READ_ENABLED: 'true',
  RESEND_API_KEY: 'no-external-delivery',
  RESEND_FROM_EMAIL: 'noreply@mailflow.invalid',
})

it('admits only the exact HTTPS base and a single DNS-safe tenant label in this environment', () => {
  const allowed = createAuthOriginPolicy(config)
  for (const origin of [config.siteURL, config.webAppURL, 'https://acme.app.staging.example.com'])
    expect(allowed(origin)).toBe(true)
  for (const origin of [
    'null',
    'http://acme.app.staging.example.com',
    'https://acme.app.staging.example.com:8443',
    'https://acme.app.staging.example.com.attacker.com',
    'https://a.b.app.staging.example.com',
    'https://acme.app.production.example.com',
    'https://user:pass@acme.app.staging.example.com',
    'https://acme.app.staging.example.com/path',
    'https://-acme.app.staging.example.com',
  ])
    expect(allowed(origin)).toBe(false)
})

it('gives Better Auth only the validated request origin, without wildcard callback permissions', () => {
  const tenant = 'https://acme.app.staging.example.com'
  const request = new Request(config.baseURL, { headers: { Origin: tenant } })
  expect(trustedAuthOrigins(config, request)).toEqual([...config.allowedOrigins, tenant])
  expect(
    trustedAuthOrigins(
      config,
      new Request(config.baseURL, { headers: { Origin: 'https://evil.com' } }),
    ),
  ).toEqual(config.allowedOrigins)
  expect(trustedAuthOrigins(config)).toEqual(config.allowedOrigins)
})

it('uses Secure HttpOnly Lax cookies only under the environment Web base', () => {
  const options = createAuthOptions(
    config,
    async () => {},
    () => {},
  )
  expect(options.advanced.crossSubDomainCookies).toEqual({
    enabled: true,
    domain: 'app.staging.example.com',
  })
  expect(options.advanced.useSecureCookies).toBe(true)
  expect(options.advanced.defaultCookieAttributes).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  })
})

const development = { ...config, appEnv: 'development' as const }
delete development.workspaceDeployment
it('allows exact loopback hosts on arbitrary HTTP or HTTPS development ports', () => {
  const allowed = createAuthOriginPolicy(development)
  for (const origin of [
    'http://localhost:3001',
    'http://localhost:5173',
    'https://localhost:8443',
    'http://localhost',
    'http://127.0.0.1:3001',
    'http://[::1]:3001',
  ])
    expect(allowed(origin)).toBe(true)
})
it('rejects localhost lookalikes, URL paths, credentials and non-web protocols', () => {
  const allowed = createAuthOriginPolicy(development)
  for (const origin of [
    'http://localhost.evil.test:3001',
    'http://localhost-evil:3001',
    'http://evil.localhost:3001',
    'http://localhost:3001/path',
    'http://user@localhost:3001',
    'http://localhost:3001?x=1',
    'ftp://localhost:3001',
    'null',
  ])
    expect(allowed(origin)).toBe(false)
})
it.each(['staging', 'production'] as const)(
  'does not allow unconfigured loopback origins in %s',
  (appEnv) => {
    const allowed = createAuthOriginPolicy({ ...config, appEnv })
    for (const origin of [
      'http://localhost:3001',
      'https://localhost:3001',
      'http://127.0.0.1:3001',
    ])
      expect(allowed(origin)).toBe(false)
  },
)
it('uses a dynamic origin provider in development for auth requests and callbacks', () => {
  const options = createAuthOptions(development, async () => {})
  expect(options.trustedOrigins).toBeTypeOf('function')
})

it('reflects allowed development ports in credentialed CORS and blocks lookalikes', async () => {
  const app = new Hono()
  installAuthRoutes(app, {
    auth: { handler: async () => new Response(), api: { getSession: async () => null } },
    allowedOrigins: development.allowedOrigins,
    isAllowedOrigin: createAuthOriginPolicy(development),
  })
  for (const origin of ['http://localhost:3001', 'http://127.0.0.1:5173']) {
    const response = await app.request('/api/auth/get-session', {
      method: 'OPTIONS',
      headers: { origin, 'Access-Control-Request-Method': 'POST' },
    })
    expect(response.headers.get('access-control-allow-origin')).toBe(origin)
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
  }
  const rejected = await app.request('/api/auth/get-session', {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost.evil.test:3001', 'Access-Control-Request-Method': 'POST' },
  })
  expect(rejected.headers.get('access-control-allow-origin')).toBeNull()
})

it('allows the workspace selector for trusted Mail preflight only', async () => {
  const app = new Hono()
  installAuthRoutes(app, {
    auth: { handler: async () => new Response(), api: { getSession: async () => null } },
    allowedOrigins: config.allowedOrigins,
    isAllowedOrigin: createAuthOriginPolicy(config),
  })
  const request = (origin: string) =>
    app.request('/api/v1/mail/send', {
      method: 'OPTIONS',
      headers: {
        origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-workspace-id,x-workspace-identity',
      },
    })
  const accepted = await request('https://acme.app.staging.example.com')
  expect(accepted.status).toBe(204)
  expect(accepted.headers.get('access-control-allow-origin')).toBe(
    'https://acme.app.staging.example.com',
  )
  expect(accepted.headers.get('access-control-allow-credentials')).toBe('true')
  expect(
    accepted.headers
      .get('access-control-allow-headers')
      ?.toLowerCase()
      .split(',')
      .map((value) => value.trim()),
  ).toContain('x-workspace-id')
  const rejected = await request('https://evil.example.com')
  expect(rejected.headers.get('access-control-allow-origin')).toBeNull()
})
