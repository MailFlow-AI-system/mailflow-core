import { expect, it } from 'vitest'
import {
  loadWorkspaceWebBaseOrigin,
  onboardingDeliveryEnabled,
  onboardingEnabled,
  signupCutoverEnabled,
} from './runtimeConfig.js'

it('keeps rollout dark by default and rejects unsafe or incomplete cutover configuration', () => {
  expect(onboardingEnabled({})).toBe(false)
  expect(onboardingDeliveryEnabled({})).toBe(false)
  expect(signupCutoverEnabled({})).toBe(false)
  expect(() => signupCutoverEnabled({ WORKSPACE_SIGNUP_CUTOVER_ENABLED: 'true' })).toThrow(
    'requires enabled',
  )
  expect(
    loadWorkspaceWebBaseOrigin({
      APP_ENV: 'development',
      WORKSPACE_WEB_BASE_ORIGIN: 'http://workspace.test:3001/',
    }),
  ).toBe('http://workspace.test:3001')
  for (const WORKSPACE_WEB_BASE_ORIGIN of [
    'http://workspace.test',
    'https://user@workspace.test',
    'https://workspace.test/path',
    'https://workspace.test?x=1',
    'https://*.workspace.test',
    'https://127.0.0.1',
    'https://localhost',
    'https://online',
  ]) {
    expect(() =>
      loadWorkspaceWebBaseOrigin({ APP_ENV: 'staging', WORKSPACE_WEB_BASE_ORIGIN }),
    ).toThrow()
  }
})

it('accepts two-label and nested environment base hosts', () => {
  for (const origin of [
    'https://mailflow-ai.online',
    'https://staging.mailflow-ai.online',
    'https://dev.mailflow-ai.online',
  ])
    expect(
      loadWorkspaceWebBaseOrigin({ APP_ENV: 'production', WORKSPACE_WEB_BASE_ORIGIN: origin }),
    ).toBe(origin)
  expect(
    loadWorkspaceWebBaseOrigin({
      APP_ENV: 'development',
      WORKSPACE_WEB_BASE_ORIGIN: 'http://localhost:3000',
    }),
  ).toBe('http://localhost:3000')
})
