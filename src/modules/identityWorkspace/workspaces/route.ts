import { OpenAPIHono } from '@hono/zod-openapi'
import { problemDetailsResponse } from '#shared/http/problemDetails'
import { listWorkspacesRoute, workspaceContextRoute } from './contract.js'
import type {
  DiscoveryBudget,
  WorkspaceMiddleware,
  WorkspaceReader,
  WorkspaceRouteEnvironment,
} from './types.js'

export function createWorkspaceRoutes(reader: WorkspaceReader, consumeBudget: DiscoveryBudget) {
  const app = new OpenAPIHono<WorkspaceRouteEnvironment>({
    defaultHook: (result, context) => {
      if (!result.success)
        return problemDetailsResponse(context, {
          title: 'Invalid request',
          status: 400,
          detail: 'Invalid workspace selector or cursor.',
          code: 'invalid_workspace_request',
        })
    },
  })
  const authorize: WorkspaceMiddleware = async (context, next) => {
    context.header('Cache-Control', 'private, no-store')
    const session = context.get('authSession')
    if (!session)
      return problemDetailsResponse(context, {
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication is required.',
        code: 'authentication_required',
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
  app.use('/api/v1/workspaces', authorize)
  app.use('/api/v1/workspaces/*', authorize)
  app.openapi(listWorkspacesRoute, async (context) => {
    const { cursor } = context.req.valid('query')
    return context.json(await reader.list(context.get('authSession').user.id, cursor), 200)
  })
  app.openapi(workspaceContextRoute, async (context) => {
    const workspace = await reader.context(
      context.get('authSession').user.id,
      context.req.valid('param').slug,
    )
    if (!workspace)
      return problemDetailsResponse(context, {
        title: 'Workspace unavailable',
        status: 404,
        detail: 'This workspace is unavailable.',
        code: 'workspace_unavailable',
      })
    return context.json({ workspace }, 200)
  })
  return app
}
