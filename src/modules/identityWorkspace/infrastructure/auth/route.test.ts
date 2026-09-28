import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

import type { AuthService } from '../types/auth.js'
import { installAuthRoutes } from './route.js'

function createAuth(
  session: Awaited<ReturnType<AuthService['api']['getSession']>> = null,
): AuthService {
  return {
    handler: vi.fn(async () => Response.json({ delegated: true })),
    api: {
      getSession: vi.fn(async () => session),
    },
  }
}

function createApp(auth: AuthService) {
  const app = new Hono()

  installAuthRoutes(app, {
    auth,
    allowedOrigins: ['http://localhost:4321', 'http://localhost:3000'],
  })
  app.get('/api/v1/private', (context) => context.json({ protected: true }))

  return app
}

describe('authentication HTTP integration', () => {
  it('allows credentialed CORS only for configured frontend origins', async () => {
    const app = createApp(createAuth())

    const allowed = await app.request('/api/auth/get-session', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'content-type,traceparent,tracestate',
      },
    })
    const rejected = await app.request('/api/auth/get-session', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://untrusted.example',
        'Access-Control-Request-Method': 'GET',
      },
    })

    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')
    expect(allowed.headers.get('access-control-allow-headers')).toContain('traceparent')
    expect(allowed.headers.get('access-control-allow-headers')).toContain('tracestate')
    expect(rejected.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('delegates Better Auth endpoints to its handler', async () => {
    const auth = createAuth()
    const app = createApp(auth)

    const response = await app.request('/api/auth/get-session')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ delegated: true })
    expect(auth.handler).toHaveBeenCalledOnce()
  })

  it('rejects an unauthenticated API resource request', async () => {
    const app = createApp(createAuth())

    const response = await app.request('/api/v1/private')

    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(await response.json()).toMatchObject({
      title: 'Unauthorized',
      status: 401,
      code: 'authentication_required',
    })
  })

  it('allows an authenticated API resource request', async () => {
    const app = createApp(
      createAuth({
        session: { id: 'session-1' },
        user: { id: 'user-1' },
      }),
    )

    const response = await app.request('/api/v1/private')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ protected: true })
  })
})
