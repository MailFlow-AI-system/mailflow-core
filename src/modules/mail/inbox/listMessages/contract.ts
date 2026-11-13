import { createRoute, z } from '@hono/zod-openapi'
import { mailFolders } from '../messageActions/contract.js'

const labelSchema = z.object({ id: z.uuid(), name: z.string(), color: z.string() })

const messageSchema = z.object({
  id: z.uuid(),
  senderName: z.string(),
  subject: z.string(),
  body: z.string(),
  receivedAt: z.iso.datetime(),
  labels: z.array(labelSchema).optional(),
  isRead: z.boolean().openapi({ description: 'Read by the current user.' }),
  isStarred: z.boolean().openapi({ description: 'Starred by the current user.' }),
  folder: z.enum(['inbox', 'archive', 'trash', 'spam']),
  archivedAt: z.iso.datetime().nullable(),
  archivedBy: z.string().nullable().openapi({ description: 'User id of the actor.' }),
  trashedAt: z.iso.datetime().nullable(),
  trashedBy: z.string().nullable(),
  spamAt: z.iso.datetime().nullable(),
  spamBy: z.string().nullable(),
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
  path: '/api/v1/workspaces/{slug}/mail/messages',
  tags: ['Mail'],
  summary: 'List the workspace inbox in pages of eight messages',
  description:
    'Requires a valid session. Search is a case-insensitive literal substring across sender, subject, and full body. Pass nextCursor unchanged for the next page with the same search.',
  request: {
    params: z.object({
      slug: z
        .string()
        .max(63)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    }),
    query: z.object({
      q: z
        .string()
        .optional()
        .openapi({ description: 'Optional search text, trimmed by the API.' }),
      cursor: z.string().optional().openapi({ description: 'Opaque next-page cursor.' }),
      folder: z
        .enum(mailFolders)
        .optional()
        .openapi({ description: 'Folder to list; defaults to inbox.' }),
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
      description: 'The message cursor or folder is invalid.',
      content: { 'application/problem+json': { schema: problemSchema } },
    },
    401: {
      description: 'Authentication is required.',
      content: { 'application/problem+json': { schema: problemSchema } },
    },
    403: {
      description: 'The session identity has changed.',
      content: { 'application/problem+json': { schema: problemSchema } },
    },
    404: {
      description: 'The workspace is unavailable.',
      content: { 'application/problem+json': { schema: problemSchema } },
    },
    500: {
      description: 'An unexpected error occurred.',
      content: { 'application/problem+json': { schema: problemSchema } },
    },
  },
})
