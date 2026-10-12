import type { AuthConfig, AuthOriginPolicy } from '../types/authConfig.js'

export function createAuthOriginPolicy(config: AuthConfig): AuthOriginPolicy {
  return (origin) => {
    if (config.allowedOrigins.includes(origin)) return true
    const deployment = config.workspaceDeployment
    if (!deployment) return false
    try {
      const url = new URL(origin)
      if (
        url.origin !== origin ||
        url.protocol !== 'https:' ||
        url.port ||
        url.username ||
        url.password
      )
        return false
      if (url.hostname === deployment.baseHost) return true
      const suffix = `.${deployment.baseHost}`
      if (!url.hostname.endsWith(suffix)) return false
      const slug = url.hostname.slice(0, -suffix.length)
      return slug.length <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
    } catch {
      return false
    }
  }
}

export function trustedAuthOrigins(config: AuthConfig, request?: Request) {
  const origin = request?.headers.get('origin')
  if (origin && createAuthOriginPolicy(config)(origin))
    return [...new Set([...config.allowedOrigins, origin])]
  return config.allowedOrigins
}
