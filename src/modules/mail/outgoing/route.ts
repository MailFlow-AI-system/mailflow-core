import { OpenAPIHono } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { problemDetailsResponse } from '#shared/http/problemDetails'
import { discardEmailRoute, sendEmailRoute, sentEmailsRoute } from './contract.js'
import { MessageConflictError, sendEmail } from './sendEmail.js'
import type { OutgoingMail } from './types.js'

export function createOutgoingMailModule(
  dependencies: OutgoingMail,
  isAllowedOrigin: (origin: string) => boolean,
) {
  const app = new OpenAPIHono()
  for (const path of ['/api/v1/mail/send', '/api/v1/mail/discard'])
    app.use(path, async (context, next) => {
      if (!isAllowedOrigin(context.req.header('origin') ?? ''))
        return problemDetailsResponse(context, {
          title: 'Forbidden',
          status: 403,
          detail: 'A trusted Origin is required.',
          code: 'untrusted_origin',
        })
      await next()
    })
  app.use(
    '/api/v1/mail/send',
    bodyLimit({
      maxSize: 13 * 1024 * 1024,
      onError: (context) =>
        problemDetailsResponse(context, {
          title: 'Payload too large',
          status: 413,
          detail: 'The email is too large.',
          code: 'email_too_large',
        }),
    }),
  )
  app.use('/api/v1/mail/send', async (context, next) => {
    let body: unknown
    try {
      body = await context.req.json()
    } catch {
      return problemDetailsResponse(context, {
        title: 'Bad request',
        status: 400,
        detail: 'A valid JSON message is required.',
        code: 'invalid_json',
      })
    }
    const files =
      body && typeof body === 'object' && 'attachments' in body ? body.attachments : null
    if (
      Array.isArray(files) &&
      files.some(
        (file) => file && typeof file === 'object' && ('content' in file || 'filename' in file),
      )
    )
      return problemDetailsResponse(context, {
        title: 'Legacy attachment format',
        status: 400,
        detail: 'Please upload attachments again before sending.',
        code: 'legacy_attachment_unsupported',
      })
    await next()
  })
  app.use(
    '/api/v1/mail/discard',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (context) =>
        problemDetailsResponse(context, {
          title: 'Payload too large',
          status: 413,
          detail: 'The discard batch is too large.',
          code: 'discard_too_large',
        }),
    }),
  )
  app.use('/api/v1/mail/discard', async (context, next) => {
    try {
      await context.req.json()
    } catch {
      return problemDetailsResponse(context, {
        title: 'Bad request',
        status: 400,
        detail: 'A valid JSON message is required.',
        code: 'invalid_json',
      })
    }
    await next()
  })
  app.openapi(discardEmailRoute, async (context) => {
    try {
      return context.json(
        await dependencies.repository.discard(
          context.get('mailContext'),
          context.req.valid('json'),
        ),
        200,
      )
    } catch {
      return problemDetailsResponse(context, {
        title: 'Discard unavailable',
        status: 502,
        detail: 'The discard could not be confirmed. Retry the same request.',
        code: 'email_discard_failed',
      })
    }
  })
  app.openapi(sendEmailRoute, async (context) => {
    try {
      return context.json(
        await sendEmail(dependencies, context.get('mailContext'), context.req.valid('json')),
        200,
      )
    } catch (error) {
      const conflict = error instanceof MessageConflictError
      return problemDetailsResponse(context, {
        title: conflict ? 'Conflict' : 'Email unavailable',
        status: conflict ? 409 : 502,
        detail: conflict
          ? 'The message id cannot be reused. Check Sent before composing a new message.'
          : 'The email could not be confirmed. Retry the same message.',
        code: conflict ? 'email_conflict' : 'email_send_failed',
      })
    }
  })
  app.openapi(sentEmailsRoute, async (context) => {
    const offset = context.req.valid('query').offset
    const messages = await dependencies.repository.listSent(context.get('mailContext'), offset)
    return context.json(
      {
        items: messages
          .slice(0, 20)
          .map((message) => ({ ...message, sentAt: message.sentAt?.toISOString() ?? null })),
        nextOffset: messages.length > 20 ? offset + 20 : null,
      },
      200,
    )
  })
  return app
}
