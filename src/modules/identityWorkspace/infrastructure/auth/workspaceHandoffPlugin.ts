import { createHash, randomBytes } from 'node:crypto'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { z } from 'zod'
import type { WorkspaceDeploymentConfig } from '../types/authConfig.js'
import type { WorkspaceHandoffStore } from '../types/authOptions.js'
import { workspaceSlugFromOrigin } from './authOriginPolicy.js'
import { workspaceOrigin } from './workspaceDeployment.js'

export const WORKSPACE_HANDOFF_PATH = '/auth/handoff'
export const WORKSPACE_HANDOFF_LIFETIME_SECONDS = 60
function noStore(ctx: { setHeader: (name: string, value: string) => void }) {
  ctx.setHeader('Cache-Control', 'private, no-store')
  ctx.setHeader('Referrer-Policy', 'no-referrer')
}

export function hashWorkspaceHandoffCode(code: string) {
  return createHash('sha256').update(code).digest('hex')
}

const invalidHandoff = () =>
  APIError.from('BAD_REQUEST', {
    code: 'WORKSPACE_HANDOFF_INVALID',
    message: 'This workspace link is invalid or has expired.',
  })

// Moves a signed-in user between workspace hosts without sharing cookies across subdomains.
// The source host issues a 256-bit single-use code; the destination host exchanges it for a
// new host-only session. Codes are never logged or stored in plain text.
export function workspaceHandoff(
  deployment: WorkspaceDeploymentConfig,
  store: WorkspaceHandoffStore,
) {
  return {
    id: 'workspace-handoff',
    endpoints: {
      issueWorkspaceHandoff: createAuthEndpoint(
        '/workspace-handoff/issue',
        {
          method: 'POST',
          body: z.object({ workspaceId: z.string().min(1).max(128) }).strict(),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const code = randomBytes(32).toString('base64url')
          const slug = await store.issue(
            ctx.context.session.user.id,
            ctx.body.workspaceId,
            hashWorkspaceHandoffCode(code),
          )
          if (!slug)
            throw APIError.from('NOT_FOUND', {
              code: 'WORKSPACE_UNAVAILABLE',
              message: 'This workspace is unavailable.',
            })
          const url = new URL(WORKSPACE_HANDOFF_PATH, workspaceOrigin(deployment, slug))
          url.searchParams.set('code', code)
          noStore(ctx)
          return ctx.json({ url: url.href })
        },
      ),
      exchangeWorkspaceHandoff: createAuthEndpoint(
        '/workspace-handoff/exchange',
        {
          method: 'POST',
          body: z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
        },
        async (ctx) => {
          const origin = ctx.request?.headers.get('origin')
          const hostSlug =
            origin && URL.canParse(origin)
              ? workspaceSlugFromOrigin(deployment, new URL(origin))
              : undefined
          if (!hostSlug) throw invalidHandoff()
          const grant = await store.consume(hashWorkspaceHandoffCode(ctx.body.code), hostSlug)
          if (!grant) throw invalidHandoff()
          const user = await ctx.context.internalAdapter.findUserById(grant.userId)
          if (!user) throw invalidHandoff()
          const session = await ctx.context.internalAdapter.createSession(user.id)
          await setSessionCookie(ctx, { session, user })
          noStore(ctx)
          return ctx.json({ status: true })
        },
      ),
    },
  } satisfies BetterAuthPlugin
}
