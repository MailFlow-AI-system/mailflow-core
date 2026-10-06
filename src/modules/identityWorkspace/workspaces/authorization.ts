import { problemDetailsResponse } from '#shared/http/problemDetails'
import type { DiscoveryBudget, WorkspaceMiddleware } from './types.js'

export function authorizeWorkspaceDiscovery(consumeBudget: DiscoveryBudget): WorkspaceMiddleware {
  return async (context, next) => {
    context.header('Cache-Control', 'private, no-store')
    const session = context.get('authSession')
    if (!session)
      return problemDetailsResponse(context, {
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication is required.',
        code: 'authentication_required',
      })
    context.header('X-Workspace-Identity', session.user.id)
    const expectedIdentity = context.req.header('X-Workspace-Identity')
    if (expectedIdentity && expectedIdentity !== session.user.id)
      return problemDetailsResponse(context, {
        title: 'Forbidden',
        status: 403,
        detail: 'The authenticated identity has changed.',
        code: 'workspace_identity_changed',
      })
    const retryAfter = await consumeBudget(session.user.id)
    if (retryAfter) {
      context.header('Retry-After', String(retryAfter))
      return problemDetailsResponse(context, {
        title: 'Too many requests',
        status: 429,
        detail: 'Please wait before retrying.',
        code: 'workspace_rate_limited',
      })
    }
    await next()
  }
}
