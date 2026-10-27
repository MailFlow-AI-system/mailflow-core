import type { MiddlewareHandler } from 'hono'
import type { MailWorkspaceAuthority, WorkspaceSummary } from '#modules/identityWorkspace'
import { problemDetailsResponse } from '#shared/http/problemDetails'
import type {} from './types.js'

declare module 'hono' {
  interface ContextVariableMap {
    mailWorkspace: WorkspaceSummary
  }
}

type Options = { isAllowedOrigin: (origin: string) => boolean; workspaceBaseOrigin?: string }
export function createMailContextMiddleware(
  authority: MailWorkspaceAuthority | undefined,
  options: Options,
): MiddlewareHandler {
  return async (context, next) => {
    const session = context.get('authSession')
    if (!session)
      return problemDetailsResponse(context, {
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication is required.',
        code: 'authentication_required',
      })
    const expected = context.req.header('X-Workspace-Identity')
    if (expected && expected !== session.user.id)
      return problemDetailsResponse(context, {
        title: 'Forbidden',
        status: 403,
        detail: 'The authenticated identity has changed.',
        code: 'workspace_identity_changed',
      })
    const origin = context.req.header('Origin')
    if (origin && !options.isAllowedOrigin(origin))
      return problemDetailsResponse(context, {
        title: 'Forbidden',
        status: 403,
        detail: 'A trusted origin is required.',
        code: 'untrusted_origin',
      })
    const workspaceId = context.req.header('X-Workspace-Id')
    if (
      workspaceId !== undefined &&
      (!workspaceId ||
        workspaceId.length > 128 ||
        workspaceId.trim() !== workspaceId ||
        !/^[!-~]+$/.test(workspaceId) ||
        workspaceId.includes(','))
    )
      return problemDetailsResponse(context, {
        title: 'Forbidden',
        status: 403,
        detail: 'Workspace is unavailable.',
        code: 'workspace_unavailable',
      })
    let slug: string | undefined
    if (origin && options.workspaceBaseOrigin) {
      const url = new URL(origin)
      const base = new URL(options.workspaceBaseOrigin)
      const suffix = `.${base.hostname}`
      if (
        url.protocol === base.protocol &&
        url.port === base.port &&
        url.hostname.endsWith(suffix)
      ) {
        const candidate = url.hostname.slice(0, -suffix.length)
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate) || candidate.length > 63)
          return problemDetailsResponse(context, {
            title: 'Forbidden',
            status: 403,
            detail: 'Workspace is unavailable.',
            code: 'workspace_unavailable',
          })
        slug = candidate
      }
    }
    if (!authority)
      return problemDetailsResponse(context, {
        title: 'Service unavailable',
        status: 503,
        detail: 'Workspace access is temporarily unavailable.',
        code: 'workspace_unavailable',
      })
    try {
      const result = await authority.resolve(session.user.id, {
        ...(workspaceId ? { workspaceId } : {}),
        ...(slug ? { slug } : {}),
      })
      if (result.status === 'required')
        return problemDetailsResponse(context, {
          title: 'Workspace required',
          status: 409,
          detail: 'Select a workspace before continuing.',
          code: 'workspace_required',
        })
      if (result.status === 'unavailable')
        return problemDetailsResponse(context, {
          title: 'Forbidden',
          status: 403,
          detail: 'Workspace is unavailable.',
          code: 'workspace_unavailable',
        })
      context.set('mailContext', { workspaceId: result.workspace.id, userId: session.user.id })
      context.set('mailWorkspace', result.workspace)
    } catch {
      return problemDetailsResponse(context, {
        title: 'Service unavailable',
        status: 503,
        detail: 'Workspace access is temporarily unavailable.',
        code: 'workspace_unavailable',
      })
    }
    await next()
  }
}
