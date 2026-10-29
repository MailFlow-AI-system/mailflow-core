import type { MiddlewareHandler } from 'hono'
import { problemDetailsResponse } from '#shared/http/problemDetails'
import type { MailEnvironment, ResolveWorkspace } from './listMessages/types.js'

export function authorizeWorkspaceMail(
  resolveWorkspace: ResolveWorkspace,
): MiddlewareHandler<MailEnvironment> {
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
    const slug = context.req.param('slug') ?? ''
    if (slug.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      return problemDetailsResponse(context, {
        title: 'Bad Request',
        status: 400,
        detail: 'Invalid workspace selector.',
        code: 'invalid_workspace_request',
      })
    const workspace = await resolveWorkspace(session.user.id, slug)
    if (!workspace)
      return problemDetailsResponse(context, {
        title: 'Workspace unavailable',
        status: 404,
        detail: 'This workspace is unavailable.',
        code: 'workspace_unavailable',
      })
    context.header('X-Workspace-Id', workspace.id)
    context.set('workspaceId', workspace.id)
    await next()
  }
}
