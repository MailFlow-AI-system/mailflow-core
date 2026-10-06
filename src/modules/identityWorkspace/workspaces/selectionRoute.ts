import { OpenAPIHono } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { problemDetailsResponse } from '#shared/http/problemDetails'
import { authorizeWorkspaceDiscovery } from './authorization.js'
import { workspaceSelectionRoute } from './selectionContract.js'
import type { WorkspaceRouteEnvironment, WorkspaceSelectionDependencies } from './types.js'

export function createWorkspaceSelectionRoutes({
  selection,
  consumeBudget,
  allowedOrigins,
}: WorkspaceSelectionDependencies) {
  const app = new OpenAPIHono<WorkspaceRouteEnvironment>({
    defaultHook: (result, context) => {
      if (!result.success)
        return problemDetailsResponse(context, {
          title: 'Invalid request',
          status: 400,
          detail: 'Invalid workspace selection.',
          code: 'invalid_workspace_request',
        })
    },
  })
  app.use('/api/v1/workspace-selection', async (context, next) => {
    context.header('Cache-Control', 'private, no-store')
    if (!allowedOrigins.includes(context.req.header('Origin') ?? ''))
      return problemDetailsResponse(context, {
        title: 'Forbidden',
        status: 403,
        detail: 'Untrusted selection origin.',
        code: 'workspace_origin_denied',
      })
    await next()
  })
  app.use('/api/v1/workspace-selection', authorizeWorkspaceDiscovery(consumeBudget))
  app.use(
    '/api/v1/workspace-selection',
    bodyLimit({
      maxSize: 1024,
      onError: (context) =>
        problemDetailsResponse(context, {
          title: 'Payload too large',
          status: 413,
          detail: 'Selection payload is too large.',
          code: 'workspace_payload_too_large',
        }),
    }),
  )
  app.openapi(workspaceSelectionRoute, async (context) => {
    const workspace = await selection.select(
      context.get('authSession').user.id,
      context.req.valid('json').workspaceId,
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
