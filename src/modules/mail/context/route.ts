import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type {} from './middleware.js'

const route = createRoute({
  method: 'get',
  path: '/api/v1/mail/context',
  responses: {
    200: {
      description: 'Authorized workspace',
      content: {
        'application/json': {
          schema: z.object({
            userId: z.string(),
            workspace: z.object({
              id: z.string(),
              name: z.string(),
              slug: z.string(),
              role: z.enum(['owner', 'admin', 'member']),
            }),
          }),
        },
      },
    },
    401: { description: 'Authentication required' },
    403: { description: 'Workspace unavailable' },
    409: { description: 'Workspace required' },
    503: { description: 'Workspace unavailable' },
  },
})
export function createMailContextModule() {
  const app = new OpenAPIHono()
  app.openapi(route, (context) =>
    context.json(
      { userId: context.get('mailContext').userId, workspace: context.get('mailWorkspace') },
      200,
    ),
  )
  return app
}
