import { OpenAPIHono, z } from '@hono/zod-openapi'

import { problemDetailsResponse } from '#shared/http/problemDetails'
import { requireMailCapability } from '../../context/capabilityPolicy.js'
import { registerMessageActionRoutes } from '../messageActions/route.js'
import { authorizeWorkspaceMail } from '../workspaceAuthorization.js'
import { listMessagesRoute } from './contract.js'
import { InvalidMessageCursorError, listMessages } from './listMessages.js'
import type { MailEnvironment, MailMessageRepository, ResolveWorkspace } from './types.js'

export function createMailModule({
  repository,
  resolveWorkspace,
  isAllowedOrigin,
}: {
  repository: MailMessageRepository
  resolveWorkspace: ResolveWorkspace
  isAllowedOrigin: (origin: string) => boolean
}) {
  const app = new OpenAPIHono<MailEnvironment>()
  app.use(
    '/api/v1/workspaces/:slug/mail/*',
    authorizeWorkspaceMail(resolveWorkspace),
    requireMailCapability,
  )

  // Opening a message marks it read for the current user inside the repository transaction.
  app.get('/api/v1/workspaces/:slug/mail/messages/:id', async (context) => {
    const id = context.req.param('id')
    if (!z.uuid().safeParse(id).success) return context.notFound()
    const message = await repository.findMessage?.(
      context.get('workspaceId'),
      id,
      context.get('authSession').user.id,
    )
    if (!message) return context.notFound()
    return context.json(message)
  })

  app.openapi(
    listMessagesRoute,
    async (context) => {
      try {
        return context.json(
          await listMessages(
            repository,
            { workspaceId: context.get('workspaceId'), userId: context.get('authSession').user.id },
            context.req.valid('query'),
          ),
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
    },
    (result, context) => {
      if (!result.success)
        return problemDetailsResponse(context, {
          title: 'Bad Request',
          status: 400,
          detail: 'The message query is invalid.',
          code: 'invalid_message_query',
        })
    },
  )

  registerMessageActionRoutes(app, repository, isAllowedOrigin)

  return app
}
