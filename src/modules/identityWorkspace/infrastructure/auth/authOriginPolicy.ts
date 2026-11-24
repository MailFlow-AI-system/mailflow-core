import { RESERVED_WORKSPACE_SLUGS } from '../../onboarding/constants.js'
import type {
  AuthConfig,
  AuthOriginPolicy,
  WorkspaceDeploymentConfig,
} from '../types/authConfig.js'

const loopbackHosts = ['localhost', '127.0.0.1', '[::1]']
const developmentOrigins = loopbackHosts.flatMap((host) =>
  ['http', 'https'].flatMap((protocol) => [`${protocol}://${host}`, `${protocol}://${host}:*`]),
)

export function createAuthOriginPolicy(config: AuthConfig): AuthOriginPolicy {
  return (origin) => {
    if (config.allowedOrigins.includes(origin)) return true
    try {
      const url = new URL(origin)
      if (
        url.origin !== origin ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return false
      if (config.appEnv === 'development' && loopbackHosts.includes(url.hostname)) return true
      if (config.workspaceDeployment)
        return workspaceSlugFromOrigin(config.workspaceDeployment, url) !== undefined
      if (!config.webAppURL) return false
      const web = new URL(config.webAppURL)
      const api = new URL(config.baseURL)
      if (
        config.appEnv === 'development' &&
        api.protocol === 'http:' &&
        loopbackHosts.includes(api.hostname) &&
        (web.hostname === 'localhost' ||
          /^[a-z0-9]+(?:-[a-z0-9]+)*\.localhost$/.test(web.hostname)) &&
        web.protocol === 'http:' &&
        url.protocol === 'http:' &&
        url.port === web.port &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*\.localhost$/.test(url.hostname)
      )
        return true
      return false
    } catch {
      return false
    }
  }
}

// Returns the workspace slug when `origin` is exactly `{slug}.{base host}` with the base
// protocol and port. The bare base host, reserved names and nested labels never match.
export function workspaceSlugFromOrigin(
  deployment: WorkspaceDeploymentConfig,
  origin: URL,
): string | undefined {
  const base = new URL(deployment.webOrigin)
  if (
    origin.protocol !== base.protocol ||
    origin.port !== base.port ||
    origin.username ||
    origin.password ||
    origin.origin === 'null'
  )
    return undefined
  const suffix = `.${deployment.baseHost}`
  if (!origin.hostname.endsWith(suffix)) return undefined
  const slug = origin.hostname.slice(0, -suffix.length)
  if (
    slug.length > 63 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
    RESERVED_WORKSPACE_SLUGS.has(slug)
  )
    return undefined
  return slug
}

export function trustedAuthOrigins(config: AuthConfig, request?: Request) {
  const origins = [
    ...config.allowedOrigins,
    ...(config.appEnv === 'development' ? developmentOrigins : []),
  ]
  const origin = request?.headers.get('origin')
  if (origin && createAuthOriginPolicy(config)(origin)) return [...new Set([...origins, origin])]
  return origins
}
