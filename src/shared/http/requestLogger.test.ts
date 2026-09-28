import { Writable } from 'node:stream'
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app.js'
import type { AuthService } from '../../modules/identityWorkspace/infrastructure/types/auth.js'
import type { AppConfig } from '../config/env.js'
import type { Observability } from '../observability/observability.js'

const config: AppConfig = {
  appEnv: 'development',
  databaseUrl: 'postgresql://postgres:postgres@localhost:5432/mailflow',
  host: '127.0.0.1',
  port: 8080,
  logLevel: 'info',
  apiDocsEnabled: false,
  serviceVersion: 'test',
  otlpEndpoint: undefined,
  otelTraceSampleRate: 1,
  serviceInstanceId: 'test-instance',
}

const auth: AuthService = {
  handler: async () => new Response(),
  api: {
    getSession: async () => null,
  },
}

describe('request telemetry', () => {
  it('correlates /health/live span, metrics, and Pino log without raw request data', async () => {
    const spanExporter = new InMemorySpanExporter()
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    })
    provider.register()

    const requestDuration = { record: vi.fn() }
    const meter = {
      createCounter: vi.fn(),
      createHistogram: vi.fn(() => requestDuration),
    }
    const telemetry = {
      enabled: true,
      meter,
      serviceName: 'mailflow-core-api',
      tracer: provider.getTracer('mailflow-core-api'),
      shutdown: async () => undefined,
    } as unknown as Observability

    const logs: Array<Record<string, unknown>> = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(JSON.parse(String(chunk)) as Record<string, unknown>)
        callback()
      },
    })
    const logger = pino({ level: 'info' }, stream)
    const app = createApp({
      config,
      logger,
      observability: telemetry,
      checkDatabase: vi.fn().mockResolvedValue(undefined),
      auth,
      allowedAuthOrigins: ['http://localhost:4321', 'http://localhost:3000'],
    })

    const response = await app.request('/health/live', {
      headers: {
        'x-request-id': 'request-123',
        authorization: 'Bearer private-token',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    })
    await provider.forceFlush()

    expect(response.status).toBe(200)
    const spans = spanExporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    const span = spans[0]
    if (span === undefined) throw new Error('Expected a finished request span')
    expect(span.name).toBe('GET /health/live')
    expect(span.parentSpanContext).toMatchObject({
      spanId: '00f067aa0ba902b7',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      isRemote: true,
    })
    expect(span.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.route': '/health/live',
      'http.response.status_code': 200,
      'mailflow.request.id': 'request-123',
    })
    expect(meter.createCounter).toHaveBeenCalledWith(
      'mailflow.auth.operation.count',
      expect.objectContaining({ unit: '{operation}' }),
    )
    expect(meter.createHistogram).toHaveBeenCalledWith(
      'http.server.request.duration',
      expect.objectContaining({
        unit: 's',
        advice: {
          explicitBucketBoundaries: [
            0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
          ],
        },
      }),
    )
    expect(requestDuration.record).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({
        'http.route': '/health/live',
        'http.response.status_code': 200,
        'url.scheme': 'http',
      }),
    )
    expect(requestDuration.record.mock.calls[0]?.[0]).toBeLessThan(1)
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: 'Request completed',
        requestId: 'request-123',
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
      }),
    )
    expect(
      JSON.stringify({
        logs,
        spanAttributes: span.attributes,
        spanEvents: span.events,
        metrics: requestDuration.record.mock.calls,
      }),
    ).not.toContain('private-token')

    await provider.shutdown()
  })

  it('records only an error class when a handler fails', async () => {
    const spanExporter = new InMemorySpanExporter()
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    })
    provider.register()
    const durationRecord = vi.fn()
    const telemetry = {
      enabled: true,
      meter: {
        createCounter: () => ({ add: vi.fn() }),
        createHistogram: () => ({ record: durationRecord }),
      },
      serviceName: 'mailflow-core-api',
      tracer: provider.getTracer('mailflow-core-api'),
      shutdown: async () => undefined,
    } as unknown as Observability
    const logs: string[] = []
    const logger = pino(
      { level: 'info' },
      new Writable({
        write(chunk, _encoding, callback) {
          logs.push(String(chunk))
          callback()
        },
      }),
    )
    const app = createApp({
      config,
      logger,
      observability: telemetry,
      checkDatabase: vi.fn().mockResolvedValue(undefined),
      auth,
      allowedAuthOrigins: ['http://localhost:4321', 'http://localhost:3000'],
    })
    app.get('/failure/:email', () => {
      throw new Error('email body must never leave the request')
    })

    const response = await app.request('/failure/alice@example.com', {
      headers: { 'x-request-id': 'request-error' },
    })
    await provider.forceFlush()

    expect(response.status).toBe(500)
    expect(durationRecord).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({
        'http.route': '/failure/:email',
        'http.response.status_code': 500,
        'error.type': '500',
      }),
    )
    const span = spanExporter.getFinishedSpans()[0]
    if (span === undefined) throw new Error('Expected a finished error span')
    expect(span.events).toEqual([
      expect.objectContaining({
        name: 'exception',
        attributes: { 'exception.type': 'Error' },
      }),
    ])
    expect(JSON.stringify(span.events)).not.toContain('email body')
    expect(logs.join('')).not.toContain('email body')
    expect(logs.join('')).not.toContain('alice@example.com')
    expect(logs.join('')).not.toContain('/failure/alice@example.com')

    await provider.shutdown()
  })

  it('records only bounded auth operation outcomes and duration', async () => {
    const spanExporter = new InMemorySpanExporter()
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    })
    provider.register()

    const authCount = vi.fn()
    const authDuration = vi.fn()
    const requestDuration = vi.fn()
    const meter = {
      createCounter: vi.fn((name: string) =>
        name === 'mailflow.auth.operation.count' ? { add: authCount } : { add: vi.fn() },
      ),
      createHistogram: vi.fn((name: string) =>
        name === 'mailflow.auth.operation.duration'
          ? { record: authDuration }
          : { record: requestDuration },
      ),
    }
    const telemetry = {
      enabled: true,
      meter,
      serviceName: 'mailflow-core-api',
      tracer: provider.getTracer('mailflow-core-api'),
      shutdown: async () => undefined,
    } as unknown as Observability
    const auth: AuthService = {
      handler: async (request) => {
        switch (new URL(request.url).pathname) {
          case '/api/auth/sign-up/email':
            return Response.json({ token: 'private-token' }, { status: 200 })
          case '/api/auth/sign-in/email':
            return Response.json({ message: 'private rejection detail' }, { status: 401 })
          case '/api/auth/sign-out':
            return new Response(null, {
              status: request.headers.has('x-test-redirect') ? 302 : 503,
            })
          case '/api/auth/get-session':
            return request.headers.has('x-test-session')
              ? Response.json({
                  session: { id: 'private-session' },
                  user: { email: 'private@example.test' },
                })
              : Response.json(null)
          default:
            return new Response(null, { status: 404 })
        }
      },
      api: { getSession: async () => null },
    }
    const logs: string[] = []
    const logger = pino(
      { level: 'info' },
      new Writable({
        write(chunk, _encoding, callback) {
          logs.push(String(chunk))
          callback()
        },
      }),
    )
    const app = createApp({
      config,
      logger,
      observability: telemetry,
      checkDatabase: vi.fn().mockResolvedValue(undefined),
      auth,
      allowedAuthOrigins: ['http://localhost:4321', 'http://localhost:3000'],
    })

    await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'private@example.test', password: 'private-password' }),
    })
    await app.request('/api/auth/sign-in/email', { method: 'POST' })
    await app.request('/api/auth/sign-out', { method: 'POST' })
    await app.request('/api/auth/sign-out', {
      method: 'POST',
      headers: { 'x-test-redirect': 'true' },
    })
    await app.request('/api/auth/get-session', { method: 'GET' })
    await app.request('/api/auth/get-session', {
      method: 'GET',
      headers: { 'x-test-session': 'true' },
    })
    await provider.forceFlush()

    expect(meter.createCounter).toHaveBeenCalledWith(
      'mailflow.auth.operation.count',
      expect.objectContaining({ unit: '{operation}' }),
    )
    expect(meter.createHistogram).toHaveBeenCalledWith(
      'mailflow.auth.operation.duration',
      expect.objectContaining({ unit: 's' }),
    )
    expect(authCount.mock.calls).toEqual([
      [1, { 'mailflow.auth.operation': 'sign_up', 'mailflow.auth.result': 'success' }],
      [1, { 'mailflow.auth.operation': 'sign_in', 'mailflow.auth.result': 'rejected' }],
      [1, { 'mailflow.auth.operation': 'sign_out', 'mailflow.auth.result': 'unavailable' }],
      [1, { 'mailflow.auth.operation': 'sign_out', 'mailflow.auth.result': 'failure' }],
      [1, { 'mailflow.auth.operation': 'session_check', 'mailflow.auth.result': 'rejected' }],
      [1, { 'mailflow.auth.operation': 'session_check', 'mailflow.auth.result': 'success' }],
    ])
    expect(authDuration).toHaveBeenCalledTimes(6)
    expect(authDuration).toHaveBeenNthCalledWith(1, expect.any(Number), {
      'mailflow.auth.operation': 'sign_up',
      'mailflow.auth.result': 'success',
    })
    expect(authDuration.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(0)

    const spans = spanExporter.getFinishedSpans()
    expect(spans.map((span) => span.attributes)).toContainEqual(
      expect.objectContaining({
        'mailflow.auth.operation': 'sign_up',
        'mailflow.auth.result': 'success',
      }),
    )
    const exported = JSON.stringify({
      spans: spans.map((span) => span.attributes),
      logs,
      metrics: authCount.mock.calls,
    })
    expect(exported).not.toMatch(
      /private@example\.test|private-password|private-token|private rejection detail|private-session/,
    )

    await provider.shutdown()
  })
})
