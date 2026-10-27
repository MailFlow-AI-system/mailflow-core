import { OpenAPIHono } from '@hono/zod-openapi'

import { problemDetailsResponse } from '#shared/http/problemDetails'
import { authorizeWorkspaceMail } from '../workspaceAuthorization.js'
import { listMessagesRoute } from './contract.js'
import { InvalidMessageCursorError, listMessages } from './listMessages.js'
import type { MailEnvironment, MailMessageRepository, ResolveWorkspace } from './types.js'

export function createMailModule({
  repository,
  resolveWorkspace,
}: {
  repository: MailMessageRepository
  resolveWorkspace: ResolveWorkspace
}) {
  const app = new OpenAPIHono<MailEnvironment>()
  app.use('/api/v1/workspaces/:slug/mail/*', authorizeWorkspaceMail(resolveWorkspace))

  app.openapi(listMessagesRoute, async (context) => {
    try {
      return context.json(
        await listMessages(repository, context.get('workspaceId'), context.req.valid('query')),
        200,
      )
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
