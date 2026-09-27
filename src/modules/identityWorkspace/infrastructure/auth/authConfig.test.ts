import { describe, expect, it } from 'vitest'

import { loadAuthConfig } from './authConfig.js'

const validEnvironment = {
  APP_ENV: 'development',
  BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
  BETTER_AUTH_URL: 'http://localhost:8080',
  SITE_URL: 'http://localhost:4321',
  WEB_APP_URL: 'http://localhost:3000',
}

describe('loadAuthConfig', () => {
  it('uses frontend URLs as the exact credentialed origins', () => {
    expect(loadAuthConfig(validEnvironment)).toEqual({
      secret: validEnvironment.BETTER_AUTH_SECRET,
      baseURL: validEnvironment.BETTER_AUTH_URL,
      siteURL: validEnvironment.SITE_URL,
      webAppURL: validEnvironment.WEB_APP_URL,
      allowedOrigins: [validEnvironment.SITE_URL, validEnvironment.WEB_APP_URL],
    })
  })

  it('deduplicates identical frontend origins', () => {
    expect(
      loadAuthConfig({ ...validEnvironment, WEB_APP_URL: validEnvironment.SITE_URL })
        .allowedOrigins,
    ).toEqual([validEnvironment.SITE_URL])
  })

  it('requires a strong secret and all URLs', () => {
    expect(() => loadAuthConfig({ ...validEnvironment, BETTER_AUTH_SECRET: 'short' })).toThrow()
    expect(() => loadAuthConfig({ ...validEnvironment, WEB_APP_URL: undefined })).toThrow()
    expect(() =>
      loadAuthConfig({ ...validEnvironment, SITE_URL: 'https://*.example.com' }),
    ).toThrow()
  })

  it('requires HTTPS outside local development and tests', () => {
    expect(() => loadAuthConfig({ ...validEnvironment, APP_ENV: 'production' })).toThrow()
    expect(() =>
      loadAuthConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        BETTER_AUTH_URL: 'https://api.example.com',
        SITE_URL: 'https://www.example.com',
        WEB_APP_URL: 'https://app.example.com',
      }),
    ).not.toThrow()
  })
})
