import { describe, expect, it } from 'vitest'

import { loadAuthConfig } from './authConfig.js'

const validEnvironment = {
  APP_ENV: 'development',
  BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
  BETTER_AUTH_URL: 'http://localhost:8080',
  SITE_URL: 'http://localhost:4321',
  WEB_APP_URL: 'http://localhost:3000',
  RESEND_API_KEY: 're_test_account_email_placeholder',
  RESEND_FROM_EMAIL: 'noreply@mailflow-ai.online',
}

describe('loadAuthConfig', () => {
  it('binds workspace hosting to the environment root host without a separate entry host', () => {
    const environment = {
      ...validEnvironment,
      APP_ENV: 'production',
      BETTER_AUTH_URL: 'https://api.example.com',
      SITE_URL: 'https://example.com',
      WEB_APP_URL: 'https://app.example.com',
      WORKSPACE_WEB_BASE_ORIGIN: 'https://example.com',
      WORKSPACE_READ_ENABLED: 'true',
      WORKSPACE_SWITCHING_ENABLED: 'true',
    }
    const config = loadAuthConfig(environment)
    expect(config.workspaceDeployment).toEqual({
      baseHost: 'example.com',
      webOrigin: 'https://example.com',
    })
    // The former generic Web host only redirects; it is not a credentialed origin.
    expect(config.allowedOrigins).toEqual(['https://example.com'])
    expect(loadAuthConfig({ ...environment, WEB_APP_URL: undefined }).allowedOrigins).toEqual([
      'https://example.com',
    ])
    expect(
      loadAuthConfig({
        ...environment,
        APP_ENV: 'staging',
        SITE_URL: 'https://site-staging.example.com',
        WORKSPACE_WEB_BASE_ORIGIN: 'https://staging.example.com',
      }).workspaceDeployment,
    ).toEqual({ baseHost: 'staging.example.com', webOrigin: 'https://staging.example.com' })
    for (const origin of [
      'http://example.com',
      'https://example.com:8443',
      'https://user:password@example.com',
      'https://example.com/path',
      'https://localhost',
      'https://203.0.113.10',
    ]) {
      expect(() => loadAuthConfig({ ...environment, WORKSPACE_WEB_BASE_ORIGIN: origin })).toThrow()
    }
    expect(() => loadAuthConfig({ ...environment, WORKSPACE_WEB_BASE_ORIGIN: undefined })).toThrow()
    expect(() => loadAuthConfig({ ...environment, SITE_URL: 'http://example.com' })).toThrow()
  })
  it('hosts local workspaces under the loopback Web origin in development', () => {
    expect(
      loadAuthConfig({
        ...validEnvironment,
        WORKSPACE_WEB_BASE_ORIGIN: 'http://localhost:3000',
        WORKSPACE_READ_ENABLED: 'true',
        WORKSPACE_SWITCHING_ENABLED: 'true',
      }).workspaceDeployment,
    ).toEqual({ baseHost: 'localhost', webOrigin: 'http://localhost:3000' })
  })
  it('uses frontend URLs as the exact credentialed origins', () => {
    expect(loadAuthConfig(validEnvironment)).toEqual({
      secret: validEnvironment.BETTER_AUTH_SECRET,
      baseURL: validEnvironment.BETTER_AUTH_URL,
      siteURL: validEnvironment.SITE_URL,
      webAppURL: validEnvironment.WEB_APP_URL,
      allowedOrigins: [validEnvironment.SITE_URL, validEnvironment.WEB_APP_URL],
      appEnv: 'development',
      resend: {
        apiKey: validEnvironment.RESEND_API_KEY,
        from: validEnvironment.RESEND_FROM_EMAIL,
      },
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

  it('requires HTTPS in staging and production', () => {
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

  it.each(['development', 'staging', 'production'])(
    'rejects the shared Resend sender in %s',
    (appEnv) => {
      expect(() =>
        loadAuthConfig({
          ...validEnvironment,
          APP_ENV: appEnv,
          BETTER_AUTH_URL:
            appEnv === 'development' ? 'http://localhost:8080' : 'https://api.example.com',
          SITE_URL: appEnv === 'development' ? 'http://localhost:4321' : 'https://www.example.com',
          WEB_APP_URL:
            appEnv === 'development' ? 'http://localhost:3000' : 'https://app.example.com',
          RESEND_FROM_EMAIL: 'onboarding@resend.dev',
        }),
      ).toThrow('Authentication email sender must use a custom Resend domain, not resend.dev')
    },
  )

  it('accepts a custom-domain sender in development', () => {
    expect(loadAuthConfig(validEnvironment).resend).toEqual({
      apiKey: validEnvironment.RESEND_API_KEY,
      from: 'noreply@mailflow-ai.online',
    })
  })

  it('requires a Resend API key and accepts a custom sender in production', () => {
    expect(() =>
      loadAuthConfig({
        ...validEnvironment,
        RESEND_API_KEY: undefined,
      }),
    ).toThrow()

    expect(
      loadAuthConfig({
        ...validEnvironment,
        APP_ENV: 'production',
        BETTER_AUTH_URL: 'https://api.example.com',
        SITE_URL: 'https://www.example.com',
        WEB_APP_URL: 'https://app.example.com',
        RESEND_FROM_EMAIL: 'noreply@mailflow-ai.online',
      }).resend,
    ).toEqual({
      apiKey: validEnvironment.RESEND_API_KEY,
      from: 'noreply@mailflow-ai.online',
    })
  })
})
