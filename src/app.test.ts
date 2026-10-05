import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import type { AuthService } from './modules/identityWorkspace/infrastructure/types/auth.js'
import type { AppConfig } from './shared/config/env.js'
import type { AppDependencies } from './types/app.js'

const config: AppConfig = {
  appEnv: 'development',
  databaseUrl: 'postgresql://postgres:postgres@localhost:5432/mailflow',
  host: '127.0.0.1',
  port: 8080,
  logLevel: 'silent',
  apiDocsEnabled: true,
  serviceVersion: 'test',
  otlpEndpoint: undefined,
  otelTraceSampleRate: 0.1,
  serviceInstanceId: 'test-instance',
}

function createTestApp(
  overrides: Partial<AppConfig> = {},
  dependencies: Partial<AppDependencies> = {},
) {
  const auth: AuthService = {
    handler: vi.fn(async () => Response.json({ delegated: true })),
    api: {
      getSession: vi.fn(async () => null),
    },
  }

  return createApp({
    config: { ...config, ...overrides },
    logger: pino({ enabled: false }),
    checkDatabase: vi.fn().mockResolvedValue(undefined),
    auth,
    allowedAuthOrigins: ['http://localhost:4321', 'http://localhost:3000'],
    mailRepository: { findMessages: vi.fn().mockResolvedValue([]) },
    ...dependencies,
  })
}

describe('application', () => {
  it('blocks the global mail repository in workspace mode, including direct API requests', async () => {
    const findMessages = vi.fn().mockResolvedValue([])
    const app = createTestApp(
      {},
      {
        auth: {
          handler: async () => new Response(null),
          api: { getSession: async () => ({ session: { id: 'session' }, user: { id: 'user' } }) },
        },
        mailRepository: { findMessages },
        workspaces: {
          reader: {
            list: async () => ({ items: [], nextCursor: null }),
            context: async () => null,
          },
          consumeBudget: async () => 0,
        },
      },
    )

    const response = await app.request('/api/v1/mail/messages?q=secret')

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'workspace_mail_unavailable' })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(findMessages).not.toHaveBeenCalled()
  })

  it('preserves the authenticated global Inbox when workspace mode is disabled', async () => {
    const findMessages = vi.fn().mockResolvedValue([])
    const app = createTestApp(
      {},
      {
        auth: {
          handler: async () => new Response(null),
          api: { getSession: async () => ({ session: { id: 'session' }, user: { id: 'user' } }) },
        },
        mailRepository: { findMessages },
      },
    )

    const response = await app.request('/api/v1/mail/messages')

    expect(response.status).toBe(200)
    expect(findMessages).toHaveBeenCalledOnce()
  })

  it('still authenticates before blocking mail in workspace mode', async () => {
    const app = createTestApp(
      {},
      {
        workspaces: {
          reader: {
            list: async () => ({ items: [], nextCursor: null }),
            context: async () => null,
          },
          consumeBudget: async () => 0,
        },
      },
    )
    expect((await app.request('/api/v1/mail/messages')).status).toBe(401)
  })

  it('returns RFC 9457 problem details for an unknown route', async () => {
    const app = createTestApp()

    const response = await app.request('/missing', {
      headers: { 'x-request-id': 'request-123' },
    })

    expect(response.status).toBe(404)
    expect(response.headers.get('x-request-id')).toBe('request-123')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(await response.json()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'The requested route does not exist.',
      instance: '/missing',
      code: 'route_not_found',
      requestId: 'request-123',
    })
  })

  it('hides unexpected error details from clients', async () => {
    const app = createTestApp()
    app.get('/failure', () => {
      throw new Error('sensitive internal detail')
    })

    const response = await app.request('/failure', {
      headers: { 'x-request-id': 'request-500' },
    })
    const responseBody = await response.text()

    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(JSON.parse(responseBody)).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred.',
      instance: '/failure',
      code: 'internal_error',
      requestId: 'request-500',
    })
    expect(responseBody).not.toContain('sensitive internal detail')
  })

  it('publishes health contracts and Swagger when API docs are enabled', async () => {
    const app = createTestApp()

    const [specificationResponse, documentationResponse] = await Promise.all([
      app.request('/openapi.json'),
      app.request('/docs'),
    ])
    const specification = await specificationResponse.json()

    expect(specificationResponse.status).toBe(200)
    expect(specification.info.version).toBe('test')
    expect(specification.paths).toHaveProperty('/health/live')
    expect(specification.paths).toHaveProperty('/health/ready')
    expect(documentationResponse.status).toBe(200)
    expect(await documentationResponse.text()).toContain('SwaggerUIBundle')
  })

  it('does not publish API documentation when disabled', async () => {
    const app = createTestApp({ apiDocsEnabled: false })

    const [specificationResponse, documentationResponse] = await Promise.all([
      app.request('/openapi.json'),
      app.request('/docs'),
    ])

    expect(specificationResponse.status).toBe(404)
    expect(documentationResponse.status).toBe(404)
  })

  it('mounts Better Auth before the not-found handler', async () => {
    const app = createTestApp()

    const response = await app.request('/api/auth/get-session')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ delegated: true })
  })
})
