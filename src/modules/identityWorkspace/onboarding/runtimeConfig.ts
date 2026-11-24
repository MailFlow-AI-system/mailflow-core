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

const localBaseHosts = ['localhost', 'workspace.test']

// The base origin is the environment's workspace root, e.g. https://mailflow-ai.online or
// https://staging.mailflow-ai.online. Workspaces live on one DNS label below it.
export function loadWorkspaceWebBaseOrigin(environment: NodeJS.ProcessEnv) {
  const value = z.url({ protocol: /^https?$/ }).parse(environment.WORKSPACE_WEB_BASE_ORIGIN)
  const url = new URL(value)
  const development = (environment.APP_ENV ?? 'development') === 'development'
  const local = development && localBaseHosts.includes(url.hostname)
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
    (!local &&
      (url.hostname.split('.').length < 2 ||
        /(?:^|\.)(?:localhost|local|test|invalid)$/.test(url.hostname))) ||
    (!development && (url.protocol !== 'https:' || url.port))
  )
    throw new Error('Workspace Web base must be an exact environment origin')
  return url.origin
}
