import { isIP } from 'node:net'
import { loadWorkspaceWebBaseOrigin } from '../../onboarding/runtimeConfig.js'
import { workspaceSwitchingMode } from '../../workspaces/runtimeConfig.js'
import type { AuthConfig, WorkspaceDeploymentConfig } from '../types/authConfig.js'

export function loadWorkspaceDeployment(
  environment: NodeJS.ProcessEnv,
  origins: Pick<AuthConfig, 'baseURL' | 'siteURL' | 'webAppURL'>,
): WorkspaceDeploymentConfig | undefined {
  if (workspaceSwitchingMode(environment) !== 'remote') return undefined
  const webOrigin = loadWorkspaceWebBaseOrigin(environment)
  const web = new URL(webOrigin)
  if (
    [origins.baseURL, origins.siteURL, origins.webAppURL].some(
      (origin) => new URL(origin).protocol !== 'https:',
    ) ||
    web.protocol !== 'https:' ||
    web.port ||
    webOrigin !== origins.webAppURL ||
    isIP(web.hostname) ||
    web.hostname.split('.').length < 3 ||
    /(?:^|\.)(?:localhost|local|test|invalid)$/.test(web.hostname)
  )
    throw new Error(
      'Remote workspace switching requires an exact HTTPS Web origin with an isolated subdomain cookie scope',
    )
  return { baseHost: web.hostname, webOrigin }
}
