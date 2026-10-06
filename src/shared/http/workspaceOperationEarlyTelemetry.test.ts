import { Writable } from 'node:stream'
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import pino from 'pino'
import { expect, it, vi } from 'vitest'
import { createApp } from '../../app.js'
import { loadConfig } from '../config/env.js'
import type { Observability } from '../observability/observability.js'

it.each([
  [429, 'rate_limited'],
  [503, 'unavailable'],
  [401, 'denied'],
] as const)('classifies early HTTP %s as %s without wildcard metrics', async (status, result) => {
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const count = vi.fn()
  const meter = {
    createCounter: vi.fn((name: string) => ({
      add: name === 'mailflow.workspace.operation.count' ? count : vi.fn(),
    })),
    createHistogram: vi.fn(() => ({ record: vi.fn() })),
  }
  const logs: string[] = []
  const app = createApp({
    config: loadConfig({ DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1/unused' }),
    logger: pino(
      {},
      new Writable({
        write(chunk, _encoding, done) {
          logs.push(String(chunk))
          done()
        },
      }),
    ),
    observability: {
      meter,
      tracer: provider.getTracer('early-workspace-test'),
    } as unknown as Observability,
    checkDatabase: async () => {},
    auth: {
      handler: async () => new Response(null),
      api: {
        getSession: async () =>
          status === 401
            ? null
            : {
                user: { id: 'private-actor' },
                session: { id: 'private-session' },
              },
      },
    },
    allowedAuthOrigins: [],
    workspaces: {
      reader: { list: async () => ({ items: [], nextCursor: null }), context: async () => null },
      consumeBudget: async () => {
        if (status === 503) throw new Error('private-database-error')
        return 37
      },
    },
  })
  try {
    expect((await app.request('/api/v1/workspaces?email=private@example.test')).status).toBe(status)
    expect(count).toHaveBeenCalledWith(1, {
      'mailflow.workspace.operation': 'list',
      'mailflow.workspace.result': result,
    })
    await provider.forceFlush()
    expect(exporter.getFinishedSpans()[0]?.attributes).toMatchObject({
      'http.route': '/api/v1/workspaces',
      'mailflow.workspace.result': result,
    })
    expect(logs.join('')).not.toMatch(
      /private-actor|private-session|private@example|private-database-error/,
    )
  } finally {
    await provider.shutdown()
  }
})
