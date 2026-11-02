import type { MiddlewareHandler } from 'hono'
import type { Capability } from '#modules/identityWorkspace'
import { problemDetailsResponse } from '#shared/http/problemDetails'

declare module 'hono' {
  interface ContextVariableMap {
    mailCapabilities: readonly string[]
  }
}

type Rule = { method: 'GET' | 'POST'; path: RegExp; capability: Capability | null }

// Every mail route must be listed here. A route that is not listed is denied, so a new route cannot
// ship without choosing its capability. `null` means workspace membership alone is enough.
export const mailCapabilityPolicy: readonly Rule[] = [
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
]

export function findMailCapabilityRule(method: string, path: string) {
  return mailCapabilityPolicy.find((rule) => rule.method === method && rule.path.test(path))
}

export const requireMailCapability: MiddlewareHandler = async (context, next) => {
  const rule = findMailCapabilityRule(context.req.method, context.req.path)
  const granted = context.get('mailCapabilities')
  if (!rule || (rule.capability !== null && !granted?.includes(rule.capability)))
    return problemDetailsResponse(context, {
      title: 'Forbidden',
      status: 403,
      detail: 'Your role does not allow this action.',
      code: 'insufficient_capability',
    })
  await next()
}
