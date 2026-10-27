import { describe, expect, it } from 'vitest'
import { loadAuthConfig } from './authConfig.js'
import { localWorkspaceCookie } from './localWorkspaceCookie.js'

const config = loadAuthConfig({
  APP_ENV: 'development',
  BETTER_AUTH_SECRET: 'local-workspace-cookie-test-secret-0123456789',
  BETTER_AUTH_URL: 'http://127.0.0.1:8083',
  SITE_URL: 'http://localhost:4321',
  WEB_APP_URL: 'http://acme.workspace.test:3003',
  RESEND_API_KEY: 'synthetic-no-delivery',
  RESEND_FROM_EMAIL: 'noreply@mailflow.invalid',
})
describe('local workspace cookie policy', () => {
  it('keeps host-only defaults and permits only the explicit synthetic zone', () => {
    expect(localWorkspaceCookie(config)).toBeUndefined()
    expect(localWorkspaceCookie(config, true)).toEqual({ enabled: true, domain: 'workspace.test' })
  })
  it('rejects published environments, API origins and foreign trusted origins', () => {
    expect(() => localWorkspaceCookie({ ...config, appEnv: 'production' }, true)).toThrow(
      'isolated',
    )
    expect(() =>
      localWorkspaceCookie({ ...config, baseURL: 'https://api.example.com' }, true),
    ).toThrow('isolated')
    expect(() =>
      localWorkspaceCookie(
        { ...config, allowedOrigins: [...config.allowedOrigins, 'http://evil.example'] },
        true,
      ),
    ).toThrow('isolated')
  })
})

it('uses host-only cookies for localhost and validates all local origins', () => {
  const local = {
    ...config,
    webAppURL: 'http://localhost:3000',
    allowedOrigins: ['http://localhost:3000', 'http://localhost:4321'],
  }
  expect(localWorkspaceCookie(local, true)).toEqual({ enabled: false })
  expect(() =>
    localWorkspaceCookie({ ...local, allowedOrigins: ['http://localhost.evil.test:3000'] }, true),
  ).toThrow('isolated')
})
