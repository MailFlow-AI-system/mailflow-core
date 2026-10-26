import { createRoute, z } from '@hono/zod-openapi'

const attachmentSchema = z
  .strictObject({
    filename: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\r\n/\\]+$/),
    contentId: z
      .string()
      .min(1)
      .max(127)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    contentType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']).optional(),
    content: z
      .string()
      .max(14 * 1024 * 1024)
      .refine(
        (content) => Buffer.from(content, 'base64').toString('base64') === content,
        'Invalid base64',
      ),
  })
  .refine(
    (file) => Buffer.from(file.content, 'base64').length <= 10 * 1024 * 1024,
    'Attachment exceeds 10 MiB',
  )

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
    attachments: z.array(attachmentSchema).max(100).default([]),
  })
  .superRefine((message, context) => {
    const recipients = message.to.length + message.cc.length + message.bcc.length
    if (recipients < 1 || recipients > 50)
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'Provide between 1 and 50 recipients',
      })
    const size = message.attachments.reduce(
      (total, file) => total + Buffer.from(file.content, 'base64').length,
      0,
    )
    if (size > 25 * 1024 * 1024)
      context.addIssue({
        code: 'custom',
        path: ['attachments'],
        message: 'Attachments exceed 25 MiB',
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
