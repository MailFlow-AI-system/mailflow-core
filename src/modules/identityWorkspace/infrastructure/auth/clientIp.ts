import { createHash, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { MiddlewareHandler } from 'hono'

/** Internal header Better Auth reads the client IP from; never trusted from the client. */
export const RESOLVED_CLIENT_IP_HEADER = 'x-mailflow-resolved-client-ip'
/** Client IP forwarded by the MailFlow Web Worker, trusted only with a matching proxy secret. */
export const PROXY_CLIENT_IP_HEADER = 'x-mailflow-client-ip'
export const PROXY_SECRET_HEADER = 'x-mailflow-proxy-secret'

function validIp(value: string | null) {
  const candidate = value?.trim()
  return candidate && isIP(candidate) !== 0 ? candidate : undefined
}

function digest(value: string) {
  return createHash('sha256').update(value).digest()
}

function matchesProxySecret(provided: string | null, proxySecret: string | undefined) {
  if (!proxySecret || !provided) return false
  return timingSafeEqual(digest(provided), digest(proxySecret))
}

/**
 * Resolves the client IP used for rate limiting: the Web Worker's forwarded IP when it proves
 * the shared proxy secret, then Cloudflare's `CF-Connecting-IP`, then the platform `x-real-ip`.
 */
export function resolveClientIp(headers: Headers, proxySecret: string | undefined) {
  const forwarded = matchesProxySecret(headers.get(PROXY_SECRET_HEADER), proxySecret)
    ? validIp(headers.get(PROXY_CLIENT_IP_HEADER))
    : undefined
  return forwarded ?? validIp(headers.get('cf-connecting-ip')) ?? validIp(headers.get('x-real-ip'))
}

/** Returns a copy of the request whose only client IP signal is the normalized internal header. */
export function withResolvedClientIp(request: Request, proxySecret: string | undefined) {
  const clientIp = resolveClientIp(request.headers, proxySecret)
  const headers = new Headers(request.headers)
  headers.delete(PROXY_CLIENT_IP_HEADER)
  headers.delete(PROXY_SECRET_HEADER)
  headers.delete(RESOLVED_CLIENT_IP_HEADER)
  if (clientIp) headers.set(RESOLVED_CLIENT_IP_HEADER, clientIp)
  return new Request(request, { headers })
}

export function resolveClientIpMiddleware(proxySecret: string | undefined): MiddlewareHandler {
  return async (context, next) => {
    context.req.raw = withResolvedClientIp(context.req.raw, proxySecret)
    await next()
  }
}
