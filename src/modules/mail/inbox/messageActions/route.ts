import type { OpenAPIHono } from '@hono/zod-openapi'
import { z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { problemDetailsResponse } from '#shared/http/problemDetails'
import {
  hasMailCapability,
  insufficientCapabilityResponse,
} from '../../context/capabilityPolicy.js'
import type { MailEnvironment, MailMessageRepository } from '../listMessages/types.js'
import {
  actionPatch,
  changesWorkspaceState,
  messageActionsSchema,
  messagePatchSchema,
} from './contract.js'

const base = '/api/v1/workspaces/:slug/mail'

function problem(context: Context, status: 400 | 403 | 404 | 409, code: string, detail: string) {
  const titles = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict' }
  return problemDetailsResponse(context, { title: titles[status], status, code, detail })
}

const invalidAction = (context: Context) =>
  problem(context, 400, 'invalid_message_action', 'The message action is invalid.')
const notFound = (context: Context) =>
  problem(context, 404, 'message_not_found', 'The message is unavailable.')

export function registerMessageActionRoutes(
  app: OpenAPIHono<MailEnvironment>,
  repository: MailMessageRepository,
  isAllowedOrigin: (origin: string) => boolean,
) {
  const requireTrustedOrigin = async (context: Context, next: () => Promise<void>) => {
    if (!isAllowedOrigin(context.req.header('origin') ?? ''))
      return problem(context, 403, 'untrusted_origin', 'A trusted Origin is required.')
    await next()
  }
  const limitBody = bodyLimit({ maxSize: 32 * 1024 })
  const userId = (context: Context) => context.get('authSession').user.id

  app.get(`${base}/unread-counts`, async (context) =>
    context.json(await repository.countUnread(context.get('workspaceId'), userId(context))),
  )

  app.patch(`${base}/messages/:id`, requireTrustedOrigin, limitBody, async (context) => {
    const id = context.req.param('id') ?? ''
    if (!z.uuid().safeParse(id).success) return notFound(context)
    const patch = messagePatchSchema.safeParse(await context.req.json().catch(() => null))
    if (!patch.success) return invalidAction(context)
    if (changesWorkspaceState(patch.data) && !hasMailCapability(context, 'mail.compose'))
      return insufficientCapabilityResponse(context)
    const state = await repository.updateMessage(
      context.get('workspaceId'),
      userId(context),
      id.toLowerCase(),
      patch.data,
    )
    return state ? context.json(state) : notFound(context)
  })

  app.post(`${base}/messages/actions`, requireTrustedOrigin, limitBody, async (context) => {
    const input = messageActionsSchema.safeParse(await context.req.json().catch(() => null))
    if (!input.success) return invalidAction(context)
    const { ids, action } = input.data
    const changesWorkspace =
      action === 'delete_permanently' || changesWorkspaceState(actionPatch(action))
    if (changesWorkspace && !hasMailCapability(context, 'mail.compose'))
      return insufficientCapabilityResponse(context)
    return context.json({
      results: await repository.applyAction(
        context.get('workspaceId'),
        userId(context),
        ids,
        action,
      ),
    })
  })

  app.delete(`${base}/messages/:id`, requireTrustedOrigin, async (context) => {
    const id = context.req.param('id') ?? ''
    if (!z.uuid().safeParse(id).success) return notFound(context)
    const [result] = await repository.applyAction(
      context.get('workspaceId'),
      userId(context),
      [id.toLowerCase()],
      'delete_permanently',
    )
    if (result?.status === 'ok') return context.body(null, 204)
    if (result?.status === 'invalid_state')
      return problem(
        context,
        409,
        'message_not_in_trash',
        'Only messages in Trash can be deleted permanently.',
      )
    return notFound(context)
  })
}
