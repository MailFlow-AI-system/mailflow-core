import { createRoute, z } from '@hono/zod-openapi'

const attachmentSchema = z.strictObject({
  id: z.uuid(),
  contentId: z
    .string()
    .min(1)
    .max(127)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
})

export const sendEmailSchema = z
  .strictObject({
    id: z.uuid(),
    to: z.array(z.email()).min(1).max(50),
    cc: z.array(z.email()).max(50).default([]),
    bcc: z.array(z.email()).max(50).default([]),
    recipientName: z
      .string()
      .trim()
      .max(200)
      .regex(/^[^\r\n]*$/)
      .transform((name) => name || undefined)
      .optional(),
    subject: z
      .string()
      .max(998)
      .regex(/^[^\r\n]*$/),
    html: z.string().max(1024 * 1024),
    text: z.string().max(1024 * 1024),
    attachments: z.array(attachmentSchema).max(10).default([]),
  })
  .superRefine((message, context) => {
    const recipients = message.to.length + message.cc.length + message.bcc.length
    if (recipients < 1 || recipients > 50)
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'Provide between 1 and 50 recipients',
      })
    const ids = message.attachments.map(({ id }) => id)
    const cids = message.attachments.flatMap(({ contentId }) => (contentId ? [contentId] : []))
    if (new Set(ids).size !== ids.length || new Set(cids).size !== cids.length)
      context.addIssue({
        code: 'custom',
        path: ['attachments'],
        message: 'Attachment references must be unique',
      })
  })
export type SendEmailInput = z.infer<typeof sendEmailSchema>
const errorResponse = { description: 'The request could not be completed.' }
export const sendEmailRoute = createRoute({
  method: 'post',
  path: '/api/v1/mail/send',
  tags: ['Mail'],
  summary: 'Send an email through Resend',
  description:
    'Requires an authenticated session and trusted Origin. Reuse the same message id and content for retries. Sent means accepted by Resend, not delivered to the recipient inbox.',
  request: {
    body: { required: true, content: { 'application/json': { schema: sendEmailSchema } } },
  },
  responses: {
    200: {
      description: 'Resend accepted the email and the sent copy is persisted.',
      content: {
        'application/json': { schema: z.object({ id: z.uuid(), status: z.literal('sent') }) },
      },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    409: errorResponse,
    413: errorResponse,
    502: errorResponse,
  },
})
export const sentEmailsRoute = createRoute({
  method: 'get',
  path: '/api/v1/mail/sent',
  tags: ['Mail'],
  summary: 'List the current user sent emails',
  request: {
    query: z.object({ offset: z.coerce.number().int().min(0).max(1_000_000).default(0) }),
  },
  responses: {
    200: {
      description: 'A page of twenty confirmed emails, newest first.',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                id: z.uuid(),
                to: z.array(z.string()),
                cc: z.array(z.string()),
                bcc: z.array(z.string()),
                recipientName: z.string(),
                subject: z.string(),
                text: z.string(),
                sentAt: z.iso.datetime().nullable(),
                attachments: z
                  .array(
                    z.object({
                      id: z.uuid(),
                      filename: z.string(),
                      contentType: z.string(),
                      size: z.number(),
                      sha256: z.string(),
                      contentId: z.string().nullable(),
                    }),
                  )
                  .optional(),
              }),
            ),
            nextOffset: z.number().nullable(),
          }),
        },
      },
    },
    400: errorResponse,
    401: errorResponse,
  },
})

export const discardEmailRoute = createRoute({
  method: 'post',
  path: '/api/v1/mail/discard',
  tags: ['Mail'],
  summary: 'Discard safely unused delivery attempts and uploads',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.strictObject({
            messageIds: z.array(z.uuid()).max(100),
            attachmentIds: z.array(z.uuid()).max(100),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Unused files released; accepted or uncertain deliveries retained.',
      content: {
        'application/json': {
          schema: z.object({
            status: z.literal('discarded'),
            retainedMessageIds: z.array(z.uuid()),
          }),
        },
      },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    413: errorResponse,
    502: errorResponse,
  },
})
