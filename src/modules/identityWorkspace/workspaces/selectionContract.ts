import { createRoute, z } from '@hono/zod-openapi'
import { workspaceSummarySchema } from './contract.js'

const error = {
  description: 'Selection rejected; no preference was changed',
  content: {
    'application/problem+json': {
      schema: z.object({ code: z.string(), status: z.number() }).passthrough(),
    },
  },
}
export const workspaceSelectionRoute = createRoute({
  method: 'post',
  path: '/api/v1/workspace-selection',
  tags: ['Workspace'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ workspaceId: z.string().min(1).max(128) }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Live authorized workspace; preference committed before response',
      content: { 'application/json': { schema: z.object({ workspace: workspaceSummarySchema }) } },
    },
    400: error,
    401: error,
    403: error,
    404: error,
    413: error,
    429: error,
    500: error,
    503: error,
  },
})
