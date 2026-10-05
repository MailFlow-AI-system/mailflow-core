import { isIP } from 'node:net'
import { z } from 'zod'

const flag = z.enum(['true', 'false']).default('false')
export function onboardingEnabled(environment: NodeJS.ProcessEnv) {
  return flag.parse(environment.WORKSPACE_ONBOARDING_ENABLED) === 'true'
}
export function onboardingDeliveryEnabled(environment: NodeJS.ProcessEnv) {
  return flag.parse(environment.WORKSPACE_EMAIL_DELIVERY_ENABLED) === 'true'
}
export function signupCutoverEnabled(environment: NodeJS.ProcessEnv) {
  const enabled = flag.parse(environment.WORKSPACE_SIGNUP_CUTOVER_ENABLED) === 'true'
  if (enabled && !onboardingEnabled(environment))
    throw new Error('Signup cutover requires enabled workspace onboarding')
  return enabled
}

export function loadWorkspaceWebBaseOrigin(environment: NodeJS.ProcessEnv) {
  const value = z.url({ protocol: /^https?$/ }).parse(environment.WORKSPACE_WEB_BASE_ORIGIN)
  const url = new URL(value)
  if (
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isIP(url.hostname) !== 0 ||
    url.hostname.length > 189 ||
    url.hostname.split('.').some((label) => label.length > 63) ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(url.hostname) ||
    ((environment.APP_ENV ?? 'development') !== 'development' && url.protocol !== 'https:')
  )
    throw new Error('Workspace Web base must be an exact environment origin')
  return url.origin
}
