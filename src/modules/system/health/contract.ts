import { createRoute, z } from '@hono/zod-openapi'

const liveResponseSchema = z
  .object({
    status: z.literal('ok'),
  })
  .openapi('LiveHealthResponse')

export const liveHealthRoute = createRoute({
  method: 'get',
  path: '/health/live',
  tags: ['Health'],
  summary: 'Check whether the API process is alive',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: liveResponseSchema,
        },
      },
      description: 'The process is alive.',
    },
  },
})

const readyResponseSchema = z
  .object({
    status: z.literal('ready'),
    checks: z.object({
      database: z.literal('up'),
    }),
  })
  .openapi('ReadyHealthResponse')

const notReadyResponseSchema = z
  .object({
    status: z.literal('not_ready'),
    checks: z.object({
      database: z.literal('down'),
    }),
  })
  .openapi('NotReadyHealthResponse')

export const readyHealthRoute = createRoute({
  method: 'get',
  path: '/health/ready',
  tags: ['Health'],
  summary: 'Check whether the API can receive traffic',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: readyResponseSchema,
        },
      },
      description: 'Required dependencies are available.',
    },
    503: {
      content: {
        'application/json': {
          schema: notReadyResponseSchema,
        },
      },
      description: 'A required dependency is unavailable.',
    },
  },
})
