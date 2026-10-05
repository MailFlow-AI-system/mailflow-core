import { createRoute, z } from '@hono/zod-openapi'

export const workspaceSummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z
      .string()
      .max(63)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    role: z.enum(['owner', 'admin', 'member']),
  })
  .openapi('WorkspaceSummary')

const problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string(),
  requestId: z.string().optional(),
})
const errors = {
  400: {
    description: 'Invalid selector or cursor',
    content: { 'application/problem+json': { schema: problem } },
  },
  401: {
    description: 'Authentication required',
    content: { 'application/problem+json': { schema: problem } },
  },
  429: {
    description: 'Request budget exceeded; Retry-After is seconds',
    content: { 'application/problem+json': { schema: problem } },
  },
  500: {
    description: 'Operational failure',
    content: { 'application/problem+json': { schema: problem } },
  },
}

export const listWorkspacesRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces',
  tags: ['Workspace'],
  request: { query: z.object({ cursor: z.string().min(1).max(128).optional() }) },
  responses: {
    200: {
      description: 'Only the current identity memberships; ordered by stable ID',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(workspaceSummarySchema).max(50),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    ...errors,
  },
})

export const workspaceContextRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{slug}/context',
  tags: ['Workspace'],
  request: { params: z.object({ slug: workspaceSummarySchema.shape.slug }) },
  responses: {
    200: {
      description: 'Live, authorized workspace context',
      content: {
        'application/json': {
          schema: z.object({ workspace: workspaceSummarySchema }),
        },
      },
    },
    404: {
      description: 'Unavailable: unknown and unauthorized selectors are indistinguishable',
      content: { 'application/problem+json': { schema: problem } },
    },
    ...errors,
  },
})

export const workspaceEntryRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspace-entry',
  tags: ['Workspace'],
  request: { query: z.object({}).strict() },
  responses: {
    200: {
      description: 'Live preference, stable-ID fallback, or no membership; never a redirect',
      content: {
        'application/json': {
          schema: z.discriminatedUnion('source', [
            z.object({ source: z.literal('preference'), workspace: workspaceSummarySchema }),
            z.object({ source: z.literal('fallback'), workspace: workspaceSummarySchema }),
            z.object({ source: z.literal('none'), workspace: z.null() }),
          ]),
        },
      },
    },
    ...errors,
  },
})
