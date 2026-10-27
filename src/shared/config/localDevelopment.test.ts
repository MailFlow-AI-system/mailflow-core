import { expect, it } from 'vitest'
import { localDevelopmentEnvironment } from './localDevelopment.js'

it('uses a local runner context, never development alone, and preserves explicit controls', () => {
  const injected = {
    APP_ENV: 'development',
    DATABASE_URL: 'postgresql://app@localhost/db',
    BETTER_AUTH_URL: 'https://api-dev.mailflow-ai.online',
    WEB_APP_URL: 'https://app-dev.mailflow-ai.online',
    WORKSPACE_SWITCHING_ENABLED: 'true',
  }
  expect(localDevelopmentEnvironment(injected, false)).toEqual(injected)
  expect(localDevelopmentEnvironment(injected, true)).toMatchObject({
    BETTER_AUTH_URL: 'http://localhost:8080',
    WEB_APP_URL: 'http://localhost:3000',
    WORKSPACE_WEB_BASE_ORIGIN: 'http://localhost:3000',
    WORKSPACE_LOCAL_SWITCHING_ENABLED: 'true',
    WORKSPACE_SWITCHING_ENABLED: 'false',
    WORKSPACE_READ_ENABLED: 'true',
  })
  expect(
    localDevelopmentEnvironment({ ...injected, MAILFLOW_LOCAL_PROFILE: 'false' }, true).WEB_APP_URL,
  ).toBe(injected.WEB_APP_URL)
  expect(() => localDevelopmentEnvironment({ ...injected, APP_ENV: 'production' }, true)).toThrow(
    'local runner',
  )
  expect(() =>
    localDevelopmentEnvironment({ ...injected, RAILWAY_ENVIRONMENT_ID: 'published' }, true),
  ).toThrow('local runner')
})
