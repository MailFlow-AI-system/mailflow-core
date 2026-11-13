import type { Context, MiddlewareHandler } from 'hono'
import type { Capability } from '#modules/identityWorkspace'
import { problemDetailsResponse } from '#shared/http/problemDetails'

declare module 'hono' {
  interface ContextVariableMap {
    mailCapabilities: readonly string[]
  }
}

type Rule = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: RegExp
  capability: Capability | null
}

// Every mail route must be listed here. A route that is not listed is denied, so a new route cannot
// ship without choosing its capability. `null` means workspace membership alone is enough.
export const mailCapabilityPolicy: readonly Rule[] = [
  { method: 'GET', path: /^\/api\/v1\/mail\/drafts(?:\/[^/]+)?$/, capability: 'mail.read' },
  { method: 'PUT', path: /^\/api\/v1\/mail\/drafts\/[^/]+$/, capability: 'mail.compose' },
  { method: 'DELETE', path: /^\/api\/v1\/mail\/drafts\/[^/]+$/, capability: 'mail.compose' },
  { method: 'POST', path: /^\/api\/v1\/mail\/drafts\/discard$/, capability: 'mail.compose' },
  { method: 'GET', path: /^\/api\/v1\/mail\/context$/, capability: null },
  { method: 'GET', path: /^\/api\/v1\/mail\/sent(?:\/[^/]+)?$/, capability: 'mail.read' },
  {
    method: 'GET',
    path: /^\/api\/v1\/mail\/attachments\/[^/]+(?:\/(?:inline|download))?$/,
    capability: 'mail.read',
  },
  {
    method: 'GET',
    path: /^\/api\/v1\/workspaces\/[^/]+\/mail\/messages(?:\/[^/]+)?$/,
    capability: 'mail.read',
  },
  {
    method: 'POST',
    path: /^\/api\/v1\/mail\/(?:send|discard|attachments)$/,
    capability: 'mail.compose',
  },
  {
    method: 'POST',
    path: /^\/api\/v1\/mail\/attachments\/[^/]+\/complete$/,
    capability: 'mail.compose',
  },
  {
    method: 'GET',
    path: /^\/api\/v1\/workspaces\/[^/]+\/mail\/(?:labels(?:\/palette)?|(?:messages|sent)\/[^/]+\/labels)$/,
    capability: 'mail.read',
  },
  {
    method: 'POST',
    path: /^\/api\/v1\/workspaces\/[^/]+\/mail\/labels$/,
    capability: 'mail.compose',
  },
  {
    method: 'PUT',
    path: /^\/api\/v1\/workspaces\/[^/]+\/mail\/(?:messages|sent)\/[^/]+\/labels\/[^/]+$/,
    capability: 'mail.compose',
  },
  {
    method: 'DELETE',
    path: /^\/api\/v1\/workspaces\/[^/]+\/mail\/(?:messages|sent)\/[^/]+\/labels\/[^/]+$/,
    capability: 'mail.compose',
  },
  {
    method: 'GET',
    path: /^\/api\/v1\/workspaces\/[^/]+\/mail\/unread-counts$/,
    capability: 'mail.read',
  },
  // Message actions mix per-user state (read, star: mail.read) with workspace state (archive,
  // trash, spam: mail.compose). The table holds the minimum; the handlers require mail.compose
  // as soon as a request changes workspace state.
  {
    method: 'PATCH',
    path: /^\/api\/v1\/workspaces\/[^/]+\/mail\/messages\/[^/]+$/,
    capability: 'mail.read',
  },
  {
    method: 'POST',
    path: /^\/api\/v1\/workspaces\/[^/]+\/mail\/messages\/actions$/,
    capability: 'mail.read',
  },
  {
    method: 'DELETE',
    path: /^\/api\/v1\/workspaces\/[^/]+\/mail\/messages\/[^/]+$/,
    capability: 'mail.compose',
  },
]

export function findMailCapabilityRule(method: string, path: string) {
  return mailCapabilityPolicy.find((rule) => rule.method === method && rule.path.test(path))
}

export function insufficientCapabilityResponse(context: Context) {
  return problemDetailsResponse(context, {
    title: 'Forbidden',
    status: 403,
    detail: 'Your role does not allow this action.',
    code: 'insufficient_capability',
  })
}

/** For handlers whose required capability depends on the request body. */
export function hasMailCapability(context: Context, capability: Capability) {
  return context.get('mailCapabilities')?.includes(capability) ?? false
}

export const requireMailCapability: MiddlewareHandler = async (context, next) => {
  const rule = findMailCapabilityRule(context.req.method, context.req.path)
  if (!rule || (rule.capability !== null && !hasMailCapability(context, rule.capability)))
    return insufficientCapabilityResponse(context)
  await next()
}
