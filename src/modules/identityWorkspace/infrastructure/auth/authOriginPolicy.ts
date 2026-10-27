import type { AuthConfig, AuthOriginPolicy } from '../types/authConfig.js'

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
      const deployment = config.workspaceDeployment
      if (!deployment || url.protocol !== 'https:' || url.port) return false
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
  const origins = [
    ...config.allowedOrigins,
    ...(config.appEnv === 'development' ? developmentOrigins : []),
  ]
  const origin = request?.headers.get('origin')
  if (origin && createAuthOriginPolicy(config)(origin)) return [...new Set([...origins, origin])]
  return origins
}
