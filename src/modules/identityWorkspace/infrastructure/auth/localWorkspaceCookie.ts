import type { AuthConfig } from './authConfig.js'

export function localWorkspaceCookie(config: AuthConfig, enabled = false) {
  if (!enabled) return undefined
  const api = new URL(config.baseURL)
  const web = new URL(config.webAppURL)
  const localOrigins = config.allowedOrigins.every((origin) => {
    const url = new URL(origin)
    return (
      url.protocol === 'http:' &&
      (['localhost', '127.0.0.1', 'workspace.test'].includes(url.hostname) ||
        /^[a-z0-9]+(?:-[a-z0-9]+)*\.workspace\.test$/.test(url.hostname))
    )
  })
  if (
    config.appEnv !== 'development' ||
    api.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(api.hostname) ||
    !web.hostname.endsWith('.workspace.test') ||
    !localOrigins
  ) {
    throw new Error('Shared cookies are only authorized for isolated local workspace.test tests')
  }
  return { enabled: true, domain: 'workspace.test' }
}
