import { OpenAPIHono } from '@hono/zod-openapi'

import { problemDetailsResponse } from '#shared/http/problemDetails'
import { listMessagesRoute } from './contract.js'
import { InvalidMessageCursorError, listMessages } from './listMessages.js'
import type { MailMessageRepository } from './types.js'

export function createMailModule({ repository }: { repository: MailMessageRepository }) {
  const app = new OpenAPIHono()

  app.openapi(listMessagesRoute, async (context) => {
    try {
      return context.json(await listMessages(repository, context.req.valid('query')), 200)
    } catch (error) {
      if (error instanceof InvalidMessageCursorError) {
        return problemDetailsResponse(context, {
          title: 'Bad Request',
          status: 400,
          detail: 'The message cursor is invalid.',
          code: 'invalid_message_cursor',
        })
      }

      throw error
    }
  })

  return app
}
