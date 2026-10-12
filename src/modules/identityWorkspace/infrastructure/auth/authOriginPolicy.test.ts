import { expect, it } from 'vitest'
import { loadAuthConfig } from './authConfig.js'
import { createAuthOriginPolicy, trustedAuthOrigins } from './authOriginPolicy.js'
import { createAuthOptions } from './createAuth.js'

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
