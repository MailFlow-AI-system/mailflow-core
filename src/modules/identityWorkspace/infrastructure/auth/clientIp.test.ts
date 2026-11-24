import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

import type { AuthService } from '../types/auth.js'
import {
  PROXY_CLIENT_IP_HEADER,
  PROXY_SECRET_HEADER,
  RESOLVED_CLIENT_IP_HEADER,
  resolveClientIp,
  withResolvedClientIp,
} from './clientIp.js'
import { installAuthRoutes } from './route.js'

const secret = 'proxy-secret-for-tests-0123456789abcdef'

function headers(values: Record<string, string>) {
  return new Headers(values)
}

describe('resolveClientIp', () => {
  it('uses the forwarded client IP when the proxy secret matches', () => {
    expect(
      resolveClientIp(
        headers({
          [PROXY_SECRET_HEADER]: secret,
          [PROXY_CLIENT_IP_HEADER]: '2001:db8::7',
          'cf-connecting-ip': '2a06:98c0:3600::',
        }),
        secret,
      ),
    ).toBe('2001:db8::7')
  })

  it('falls back when the proxy secret matches but the forwarded IP is invalid', () => {
    expect(
      resolveClientIp(
        headers({
          [PROXY_SECRET_HEADER]: secret,
          [PROXY_CLIENT_IP_HEADER]: 'not-an-ip',
          'cf-connecting-ip': '198.51.100.4',
        }),
        secret,
      ),
    ).toBe('198.51.100.4')
  })

  it('ignores the forwarded IP when the proxy secret is wrong', () => {
    expect(
      resolveClientIp(
        headers({
          [PROXY_SECRET_HEADER]: `${secret}x`,
          [PROXY_CLIENT_IP_HEADER]: '203.0.113.9',
          'cf-connecting-ip': '198.51.100.4',
        }),
        secret,
      ),
    ).toBe('198.51.100.4')
  })

  it('ignores the forwarded IP when no proxy secret is configured', () => {
    expect(
      resolveClientIp(
        headers({
          [PROXY_SECRET_HEADER]: secret,
          [PROXY_CLIENT_IP_HEADER]: '203.0.113.9',
          'x-real-ip': '192.0.2.10',
        }),
        undefined,
      ),
    ).toBe('192.0.2.10')
  })

  it('prefers CF-Connecting-IP over x-real-ip', () => {
    expect(
      resolveClientIp(
        headers({ 'cf-connecting-ip': '198.51.100.4', 'x-real-ip': '192.0.2.10' }),
        secret,
      ),
    ).toBe('198.51.100.4')
  })

  it('uses x-real-ip when CF-Connecting-IP is invalid', () => {
    expect(
      resolveClientIp(
        headers({ 'cf-connecting-ip': 'garbage', 'x-real-ip': '192.0.2.10' }),
        secret,
      ),
    ).toBe('192.0.2.10')
  })

  it('returns no IP when no header holds a valid IP', () => {
    expect(
      resolveClientIp(
        headers({ 'x-real-ip': 'unknown', [RESOLVED_CLIENT_IP_HEADER]: '203.0.113.1' }),
        secret,
      ),
    ).toBeUndefined()
  })
})

describe('withResolvedClientIp', () => {
  it('strips forged proxy headers sent without the secret', () => {
    const request = withResolvedClientIp(
      new Request('http://localhost/api/auth/sign-in/email', {
        headers: {
          [PROXY_CLIENT_IP_HEADER]: '203.0.113.9',
          'x-real-ip': '192.0.2.10',
        },
      }),
      secret,
    )

    expect(request.headers.get(PROXY_CLIENT_IP_HEADER)).toBeNull()
    expect(request.headers.get(PROXY_SECRET_HEADER)).toBeNull()
    expect(request.headers.get(RESOLVED_CLIENT_IP_HEADER)).toBe('192.0.2.10')
  })

  it('strips the proxy secret and a client-supplied normalized header', () => {
    const request = withResolvedClientIp(
      new Request('http://localhost/api/auth/sign-in/email', {
        headers: {
          [PROXY_SECRET_HEADER]: secret,
          [PROXY_CLIENT_IP_HEADER]: '2001:db8::7',
          [RESOLVED_CLIENT_IP_HEADER]: '203.0.113.1',
        },
      }),
      secret,
    )

    expect(request.headers.get(PROXY_SECRET_HEADER)).toBeNull()
    expect(request.headers.get(PROXY_CLIENT_IP_HEADER)).toBeNull()
    expect(request.headers.get(RESOLVED_CLIENT_IP_HEADER)).toBe('2001:db8::7')
  })

  it('removes a client-supplied normalized header when no IP resolves', () => {
    const request = withResolvedClientIp(
      new Request('http://localhost/api/auth/get-session', {
        headers: { [RESOLVED_CLIENT_IP_HEADER]: '203.0.113.1' },
      }),
      undefined,
    )

    expect(request.headers.get(RESOLVED_CLIENT_IP_HEADER)).toBeNull()
  })

  it('keeps the request body', async () => {
    const request = withResolvedClientIp(
      new Request('http://localhost/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': '192.0.2.10' },
        body: JSON.stringify({ email: 'a@mailflow.invalid' }),
      }),
      undefined,
    )

    expect(await request.json()).toEqual({ email: 'a@mailflow.invalid' })
  })
})

describe('auth routes client IP resolution', () => {
  function createApp(proxySecret?: string) {
    const received: Request[] = []
    const auth: AuthService = {
      handler: vi.fn(async (request: Request) => {
        received.push(request)
        return Response.json({ delegated: true })
      }),
      api: { getSession: vi.fn(async () => null) },
    }
    const handleOtp = vi.fn(async (request: Request) => {
      received.push(request)
      return Response.json({ otp: true })
    })
    const app = new Hono()
    installAuthRoutes(app, {
      auth,
      allowedOrigins: ['http://localhost:3000'],
      onboarding: { handleOtp },
      ...(proxySecret ? { proxySecret } : {}),
    })
    return { app, received }
  }

  it('passes the normalized client IP to the Better Auth handler', async () => {
    const { app, received } = createApp(secret)

    await app.request('/api/auth/workspace-handoff/exchange', {
      method: 'POST',
      headers: {
        [PROXY_SECRET_HEADER]: secret,
        [PROXY_CLIENT_IP_HEADER]: '2001:db8::7',
        'cf-connecting-ip': '2a06:98c0:3600::',
      },
    })

    expect(received).toHaveLength(1)
    expect(received[0]?.headers.get(RESOLVED_CLIENT_IP_HEADER)).toBe('2001:db8::7')
    expect(received[0]?.headers.get(PROXY_SECRET_HEADER)).toBeNull()
  })

  it('passes the normalized client IP to the onboarding OTP handler', async () => {
    const { app, received } = createApp()

    await app.request('/api/auth/email-otp/send-verification-otp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [PROXY_CLIENT_IP_HEADER]: '203.0.113.9',
        'cf-connecting-ip': '198.51.100.4',
      },
      body: JSON.stringify({ email: 'a@mailflow.invalid' }),
    })

    expect(received).toHaveLength(1)
    expect(received[0]?.headers.get(RESOLVED_CLIENT_IP_HEADER)).toBe('198.51.100.4')
    expect(received[0]?.headers.get(PROXY_CLIENT_IP_HEADER)).toBeNull()
    expect(await received[0]?.json()).toEqual({ email: 'a@mailflow.invalid' })
  })
})
