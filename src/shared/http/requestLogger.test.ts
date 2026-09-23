import { Writable } from 'node:stream'
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app.js'
import type { AppConfig } from '../config/env.js'
import type { Observability } from '../observability/observability.js'

const config: AppConfig = {
  appEnv: 'test',
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

describe('request telemetry', () => {
  it('correlates /health/live span, metrics, and Pino log without raw request data', async () => {
    const spanExporter = new InMemorySpanExporter()
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    })
    provider.register()

    const requestCount = { add: vi.fn() }
    const requestDuration = { record: vi.fn() }
    const meter = {
      createCounter: vi.fn(() => requestCount),
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
    })

    const response = await app.request('/health/live', {
      headers: {
        'x-request-id': 'request-123',
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
    expect(requestCount.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        'http.route': '/health/live',
        'http.response.status_code': 200,
      }),
    )
    expect(requestDuration.record).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ 'http.route': '/health/live' }),
    )
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: 'Request completed',
        requestId: 'request-123',
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
      }),
    )
    expect(JSON.stringify(logs)).not.toContain('authorization')
    expect(JSON.stringify(logs)).not.toContain('DATABASE_URL')

    await provider.shutdown()
  })

  it('records only an error class when a handler fails', async () => {
    const spanExporter = new InMemorySpanExporter()
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    })
    provider.register()
    const telemetry = {
      enabled: true,
      meter: {
        createCounter: () => ({ add: vi.fn() }),
        createHistogram: () => ({ record: vi.fn() }),
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
    })
    app.get('/failure/:email', () => {
      throw new Error('email body must never leave the request')
    })

    const response = await app.request('/failure/alice@example.com', {
      headers: { 'x-request-id': 'request-error' },
    })
    await provider.forceFlush()

    expect(response.status).toBe(500)
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
})
