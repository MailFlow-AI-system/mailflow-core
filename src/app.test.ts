import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import type { AppConfig } from './shared/config/env.js'

const config: AppConfig = {
  appEnv: 'test',
  databaseUrl: 'postgresql://postgres:postgres@localhost:5432/mailflow',
  host: '127.0.0.1',
  port: 8080,
  logLevel: 'silent',
  apiDocsEnabled: true,
  serviceVersion: 'test',
}

function createTestApp(overrides: Partial<AppConfig> = {}) {
  return createApp({
    config: { ...config, ...overrides },
    logger: pino({ enabled: false }),
    checkDatabase: vi.fn().mockResolvedValue(undefined),
  })
}

describe('application', () => {
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
})
