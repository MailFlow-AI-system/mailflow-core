import { createRoute, z } from '@hono/zod-openapi'

const messageSchema = z.object({
  id: z.uuid(),
  senderName: z.string(),
  subject: z.string(),
  body: z.string(),
  receivedAt: z.iso.datetime(),
})

const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string(),
  requestId: z.string(),
})

export const listMessagesRoute = createRoute({
  method: 'get',
  path: '/api/v1/mail/messages',
  tags: ['Mail'],
  summary: 'List the global inbox in pages of eight messages',
  description:
    'Requires a valid session. Search is a case-insensitive literal substring across sender, subject, and full body. Pass nextCursor unchanged for the next page with the same search.',
  request: {
    query: z.object({
      q: z
        .string()
        .optional()
        .openapi({ description: 'Optional search text, trimmed by the API.' }),
      cursor: z.string().optional().openapi({ description: 'Opaque next-page cursor.' }),
    }),
  },
  responses: {
    200: {
      description: 'Messages ordered by receivedAt descending, then id descending.',
      content: {
        'application/json': {
          schema: z
            .object({ items: z.array(messageSchema).max(8), nextCursor: z.string().nullable() })
            .openapi('InboxMessagesResponse'),
        },
      },
    },
    400: {
      description: 'The message cursor is invalid.',
      content: { 'application/problem+json': { schema: problemSchema } },
    },
    401: {
      description: 'Authentication is required.',
      content: { 'application/problem+json': { schema: problemSchema } },
    },
    500: {
      description: 'An unexpected error occurred.',
      content: { 'application/problem+json': { schema: problemSchema } },
    },
  },
})
