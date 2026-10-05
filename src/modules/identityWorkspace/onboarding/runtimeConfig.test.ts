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
  ]) {
    expect(() =>
      loadWorkspaceWebBaseOrigin({ APP_ENV: 'staging', WORKSPACE_WEB_BASE_ORIGIN }),
    ).toThrow()
  }
})
