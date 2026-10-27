import type { MiddlewareHandler } from 'hono'
import { problemDetailsResponse } from '#shared/http/problemDetails'

// The legacy repository has no tenant boundary. Never use it in workspace mode.
export const blockGlobalWorkspaceMail: MiddlewareHandler = async (context) =>
  problemDetailsResponse(context, {
    title: 'Mail unavailable',
    status: 503,
    detail: 'Mail is unavailable until workspace isolation is implemented.',
    code: 'workspace_mail_unavailable',
  })
