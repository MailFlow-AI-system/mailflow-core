import { Writable } from 'node:stream'
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import { Hono } from 'hono'
import pino from 'pino'
import { expect, it, vi } from 'vitest'
import type { Observability } from '../observability/observability.js'
import { requestLogger } from './requestLogger.js'

it('correlates bounded workspace outcomes without identity, slug, credentials or bodies', async () => {
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const count = vi.fn()
  const duration = vi.fn()
  const meter = {
    createCounter: vi.fn((name: string) => ({
      add: name === 'mailflow.workspace.operation.count' ? count : vi.fn(),
    })),
    createHistogram: vi.fn((name: string) => ({
      record: name === 'mailflow.workspace.operation.duration' ? duration : vi.fn(),
    })),
  }
  const telemetry = {
    meter,
    tracer: provider.getTracer('workspace-test'),
  } as unknown as Observability
  const logs: string[] = []
  const logger = pino(
    {},
    new Writable({
      write(chunk, _encoding, done) {
        logs.push(String(chunk))
        done()
      },
    }),
  )
  const app = new Hono()
  app.use('*', requestLogger(logger, telemetry))
  app.get('/api/v1/workspaces/:slug/context', (context) =>
    context.json({ private: 'private-body' }, Number(context.req.header('x-test-status')) as 200),
  )
  try {
    for (const status of [200, 401, 403, 404, 429, 503, 500]) {
      await app.request('/api/v1/workspaces/private-slug/context?email=private@example.test', {
        headers: {
          'x-test-status': String(status),
          'x-workspace-identity': 'private-actor',
          cookie: 'private-cookie',
        },
      })
    }
    expect(count.mock.calls.map((call) => call[1])).toEqual(
      ['success', 'denied', 'denied', 'denied', 'rate_limited', 'unavailable', 'failure'].map(
        (result) => ({
          'mailflow.workspace.operation': 'context',
          'mailflow.workspace.result': result,
        }),
      ),
    )
    expect(duration).toHaveBeenCalledTimes(7)
    await provider.forceFlush()
    expect(
      exporter.getFinishedSpans().map((span) => span.attributes['mailflow.workspace.result']),
    ).toEqual(['success', 'denied', 'denied', 'denied', 'rate_limited', 'unavailable', 'failure'])
    expect(
      JSON.stringify({
        logs,
        metrics: count.mock.calls,
        spans: exporter.getFinishedSpans().map((span) => span.attributes),
      }),
    ).not.toMatch(/private-slug|private-actor|private-cookie|private-body|private@example/)
  } finally {
    await provider.shutdown()
  }
})
