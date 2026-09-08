import { describe, expect, it } from 'vitest'

import { loadConfig } from './env.js'

const requiredEnvironment = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/mailflow',
}

describe('loadConfig', () => {
  it('loads defaults for local development', () => {
    expect(loadConfig(requiredEnvironment)).toEqual({
      appEnv: 'development',
      databaseUrl: requiredEnvironment.DATABASE_URL,
      host: '0.0.0.0',
      port: 3000,
      logLevel: 'info',
      apiDocsEnabled: true,
      serviceVersion: 'development',
    })
  })

  it('disables API documentation by default in production', () => {
    expect(
      loadConfig({
        ...requiredEnvironment,
        APP_ENV: 'production',
      }).apiDocsEnabled,
    ).toBe(false)
  })

  it('rejects a missing database URL', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL')
  })

  it('parses explicit values without truthy string coercion', () => {
    expect(
      loadConfig({
        ...requiredEnvironment,
        APP_ENV: 'staging',
        API_DOCS_ENABLED: 'false',
        PORT: '4000',
        LOG_LEVEL: 'debug',
        SERVICE_VERSION: 'abc123',
      }),
    ).toMatchObject({
      appEnv: 'staging',
      apiDocsEnabled: false,
      port: 4000,
      logLevel: 'debug',
      serviceVersion: 'abc123',
    })
  })
})
