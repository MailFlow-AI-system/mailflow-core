import { loadWorkspaceWebBaseOrigin } from '../../onboarding/runtimeConfig.js'
import { workspaceSwitchingEnabled } from '../../workspaces/runtimeConfig.js'
import type { AuthConfig, WorkspaceDeploymentConfig } from '../types/authConfig.js'

export function loadWorkspaceDeployment(
  environment: NodeJS.ProcessEnv,
  origins: Pick<AuthConfig, 'appEnv' | 'baseURL' | 'siteURL'>,
): WorkspaceDeploymentConfig | undefined {
  if (!workspaceSwitchingEnabled(environment)) return undefined
  const webOrigin = loadWorkspaceWebBaseOrigin(environment)
  if (
    origins.appEnv !== 'development' &&
    [origins.baseURL, origins.siteURL, webOrigin].some(
      (origin) => new URL(origin).protocol !== 'https:',
    )
  )
    throw new Error('Workspace hosting requires HTTPS Core, Site and Web origins')
  return { baseHost: new URL(webOrigin).hostname, webOrigin }
}

export function workspaceOrigin(deployment: WorkspaceDeploymentConfig, slug: string) {
  const url = new URL(deployment.webOrigin)
  url.hostname = `${slug}.${deployment.baseHost}`
  return url.origin
}
