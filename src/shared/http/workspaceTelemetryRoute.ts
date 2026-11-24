const handoffRoutes = ['/api/auth/workspace-handoff/issue', '/api/auth/workspace-handoff/exchange']

export function workspaceTelemetryRoute(method: string, pathname: string): string | undefined {
  if (method === 'GET') {
    if (pathname === '/api/v1/workspaces') return pathname
    if (/^\/api\/v1\/workspaces\/[^/]+\/context$/.test(pathname))
      return '/api/v1/workspaces/:slug/context'
  }
  if (method === 'POST' && handoffRoutes.includes(pathname)) return pathname
  return undefined
}
