import { OpenAPIHono } from '@hono/zod-openapi'
import { problemDetailsResponse } from '#shared/http/problemDetails'
import { authorizeWorkspaceDiscovery } from './authorization.js'
import { workspaceEntryRoute } from './contract.js'
import type { WorkspaceEntryDependencies } from './entryTypes.js'
import type { WorkspaceRouteEnvironment } from './types.js'

export function createWorkspaceEntryRoutes({ reader, consumeBudget }: WorkspaceEntryDependencies) {
  const app = new OpenAPIHono<WorkspaceRouteEnvironment>({
    defaultHook: (result, context) => {
      if (!result.success)
        return problemDetailsResponse(context, {
          title: 'Invalid request',
          status: 400,
          detail: 'Workspace entry accepts no selectors.',
          code: 'invalid_workspace_request',
        })
    },
  })
  app.use('/api/v1/workspace-entry', authorizeWorkspaceDiscovery(consumeBudget))
  app.openapi(workspaceEntryRoute, async (context) =>
    context.json(await reader.resolve(context.get('authSession').user.id), 200),
  )
  return app
}
