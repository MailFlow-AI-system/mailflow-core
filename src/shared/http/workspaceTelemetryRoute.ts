export function workspaceTelemetryRoute(method: string, pathname: string): string | undefined {
  if (method === 'GET') {
    if (pathname === '/api/v1/workspaces' || pathname === '/api/v1/workspace-entry') return pathname
    if (/^\/api\/v1\/workspaces\/[^/]+\/context$/.test(pathname))
      return '/api/v1/workspaces/:slug/context'
  }
  if (method === 'POST' && pathname === '/api/v1/workspace-selection') return pathname
  return undefined
}
