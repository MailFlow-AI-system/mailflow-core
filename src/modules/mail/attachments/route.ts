import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { problemDetailsResponse } from '#shared/http/problemDetails'
import type { AttachmentService } from './service.js'
import { AttachmentQuotaError, type AttachmentView } from './types.js'

const metadata = z.strictObject({
  filename: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\r\n/\\]+$/),
  contentType: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[\w.+-]+\/[\w.+-]+$/),
  size: z.number().int().min(0).max(10_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
const params = z.object({ id: z.uuid() })
const attachment = metadata.extend({
  id: z.uuid(),
  status: z.enum(['pending', 'clean', 'rejected', 'error', 'expired']),
  rejectionReason: z.string().nullable(),
  attachmentExpiresAt: z.iso.datetime(),
  associated: z.boolean(),
})
const error = { description: 'Request failed' }
const create = createRoute({
  method: 'post',
  path: '/api/v1/mail/attachments',
  request: { body: { required: true, content: { 'application/json': { schema: metadata } } } },
  responses: {
    200: {
      description: 'Upload initialized',
      content: {
        'application/json': {
          schema: z.object({
            id: z.uuid(),
            uploadUrl: z.url(),
            headers: z.record(z.string(), z.string()),
            expiresAt: z.string(),
          }),
        },
      },
    },
    400: error,
    403: error,
    429: error,
    502: error,
  },
})
const complete = createRoute({
  method: 'post',
  path: '/api/v1/mail/attachments/{id}/complete',
  request: { params },
  responses: {
    200: {
      description: 'Attachment state',
      content: { 'application/json': { schema: attachment } },
    },
    404: error,
    502: error,
  },
})
const get = createRoute({
  method: 'get',
  path: '/api/v1/mail/attachments/{id}',
  request: { params },
  responses: {
    200: {
      description: 'Attachment state',
      content: { 'application/json': { schema: attachment } },
    },
    404: error,
  },
})
function publicRecord(record: AttachmentView) {
  const { id, filename, contentType, size, sha256, status, rejectionReason, associated } = record
  return {
    id,
    filename,
    contentType,
    size,
    sha256,
    rejectionReason,
    associated,
    attachmentExpiresAt: record.expiresAt.toISOString(),
    status,
  }
}
export function createAttachmentModule(
  service: AttachmentService,
  isAllowedOrigin: (origin: string) => boolean,
) {
  const app = new OpenAPIHono()
  app.use('/api/v1/mail/attachments/*', async (context, next) => {
    if (context.req.method === 'POST' && !isAllowedOrigin(context.req.header('origin') ?? ''))
      return problemDetailsResponse(context, {
        title: 'Forbidden',
        status: 403,
        detail: 'A trusted Origin is required.',
        code: 'untrusted_origin',
      })
    await next()
  })
  app.use('/api/v1/mail/attachments', async (context, next) => {
    if (context.req.method === 'POST' && !isAllowedOrigin(context.req.header('origin') ?? ''))
      return problemDetailsResponse(context, {
        title: 'Forbidden',
        status: 403,
        detail: 'A trusted Origin is required.',
        code: 'untrusted_origin',
      })
    await next()
  })
  app.use(
    '/api/v1/mail/attachments',
    bodyLimit({
      maxSize: 4096,
      onError: (context) =>
        problemDetailsResponse(context, {
          title: 'Payload too large',
          status: 413,
          detail: 'Attachment metadata is too large.',
          code: 'attachment_metadata_too_large',
        }),
    }),
  )
  app.openapi(create, async (context) => {
    try {
      return context.json(
        await service.create(context.get('authSession').user.id, context.req.valid('json')),
        200,
      )
    } catch (error) {
      if (error instanceof AttachmentQuotaError)
        return problemDetailsResponse(context, {
          title: 'Too many uploads',
          status: 429,
          detail: 'Wait for unused uploads to expire before adding more.',
          code: 'attachment_quota_exceeded',
        })
      return problemDetailsResponse(context, {
        title: 'Attachment unavailable',
        status: 502,
        detail: 'The upload could not be initialized.',
        code: 'attachment_unavailable',
      })
    }
  })
  app.openapi(complete, async (context) => {
    const owner = context.get('authSession').user.id
    const id = context.req.valid('param').id
    if (!(await service.get(owner, id)))
      return problemDetailsResponse(context, {
        title: 'Not found',
        status: 404,
        detail: 'Attachment not found.',
        code: 'attachment_not_found',
      })
    try {
      await service.complete(owner, id)
      const record = await service.get(owner, id)
      if (!record)
        return problemDetailsResponse(context, {
          title: 'Not found',
          status: 404,
          detail: 'Attachment not found.',
          code: 'attachment_not_found',
        })
      return context.json(publicRecord(record), 200)
    } catch {
      return problemDetailsResponse(context, {
        title: 'Attachment unavailable',
        status: 502,
        detail: 'The attachment could not be processed.',
        code: 'attachment_unavailable',
      })
    }
  })
  app.openapi(get, async (context) => {
    const record = await service.get(
      context.get('authSession').user.id,
      context.req.valid('param').id,
    )
    if (!record)
      return problemDetailsResponse(context, {
        title: 'Not found',
        status: 404,
        detail: 'Attachment not found.',
        code: 'attachment_not_found',
      })
    return context.json(publicRecord(record), 200)
  })
  app.get('/api/v1/mail/attachments/:id/download', async (context) => {
    if (!params.safeParse(context.req.param()).success) return context.notFound()
    const bytes = await service.download(
      context.get('authSession').user.id,
      context.req.param('id'),
    )
    if (!bytes) return context.notFound()
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    })
  })
  return app
}
