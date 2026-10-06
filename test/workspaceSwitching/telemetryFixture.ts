import { Writable } from 'node:stream'
import pino from 'pino'
import { z } from 'zod'
import { loadConfig } from '../../src/shared/config/env.js'
import { startObservability } from '../../src/shared/observability/observability.js'
import type { WorkspaceTelemetryRecord } from './telemetryTypes.js'

const recordSchema = z.object({
  requestId: z.string(),
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
  spanId: z.string().regex(/^[a-f0-9]{16}$/),
  status: z.number().int(),
  route: z.string(),
  'mailflow.workspace.operation': z.enum(['list', 'context', 'entry', 'selection']),
  'mailflow.workspace.result': z.enum([
    'success',
    'denied',
    'rate_limited',
    'unavailable',
    'failure',
  ]),
})

export async function createTelemetryFixture() {
  const enabled = process.env.MAILFLOW_WORKSPACE_TELEMETRY_LOCAL === 'true'
  const config = loadConfig({
    DATABASE_URL: process.env.MAILFLOW_WORKSPACE_TEST_DATABASE_URL,
    LOG_LEVEL: enabled ? 'info' : 'silent',
    ...(enabled
      ? {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:14318',
          OTEL_TRACE_SAMPLE_RATE: '1',
          SERVICE_VERSION: 'workspace-browser-local',
          OTEL_SERVICE_INSTANCE_ID: 'workspace-browser-local',
        }
      : {}),
  })
  const records: WorkspaceTelemetryRecord[] = []
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).trim().split('\n')) {
        const parsed = recordSchema.safeParse(JSON.parse(line))
        if (parsed.success) {
          records.push(parsed.data)
          if (records.length > 300) records.shift()
        }
      }
      callback()
    },
  })
  return {
    config,
    logger: enabled ? pino({}, sink) : pino({ enabled: false }),
    observability: await startObservability(config, 'mailflow-core-workspace-browser'),
    snapshot: () => [...records],
  }
}
