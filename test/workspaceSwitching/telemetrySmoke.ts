import assert from 'node:assert/strict'
import pino from 'pino'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/shared/config/env.js'
import { startObservability } from '../../src/shared/observability/observability.js'

// Fixed local receiver: this smoke never reads remote telemetry credentials.
const config = loadConfig({
  DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:55433/unused',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:14318',
  OTEL_TRACE_SAMPLE_RATE: '1',
  SERVICE_VERSION: 'workspace-local-smoke',
  OTEL_SERVICE_INSTANCE_ID: 'workspace-local-smoke',
})
const observability = await startObservability(config, 'mailflow-workspace-smoke')
let retryAfter = 0
let outage = false
const app = createApp({
  config,
  logger: pino(),
  observability,
  checkDatabase: async () => {},
  auth: {
    handler: async () => new Response(null),
    api: {
      getSession: async () => ({
        user: { id: 'synthetic-actor' },
        session: { id: 'synthetic-session' },
      }),
    },
  },
  allowedAuthOrigins: [],
  workspaces: {
    reader: { list: async () => ({ items: [], nextCursor: null }), context: async () => null },
    consumeBudget: async () => {
      if (outage) throw new Error('Synthetic control outage')
      return retryAfter
    },
  },
})
const headers = { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' }
try {
  assert.equal((await app.request('/api/v1/workspaces', { headers })).status, 200)
  assert.equal(
    (await app.request('/api/v1/workspaces/synthetic-slug/context', { headers })).status,
    404,
  )
  retryAfter = 37
  assert.equal((await app.request('/api/v1/workspaces', { headers })).status, 429)
  outage = true
  assert.equal((await app.request('/api/v1/workspaces', { headers })).status, 503)
} finally {
  await observability.shutdown()
}
