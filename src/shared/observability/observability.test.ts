import { describe, expect, it } from 'vitest'

import { loadConfig } from '../config/env.js'
import { createResourceAttributes, startObservability } from './observability.js'

const config = loadConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/mailflow',
  SERVICE_VERSION: 'test-version',
  OTEL_SERVICE_INSTANCE_ID: 'test-instance',
})

describe('observability bootstrap', () => {
  it('keeps telemetry as a safe no-op when no Collector endpoint is configured', async () => {
    const telemetry = await startObservability(config, 'mailflow-core-api')
    const span = telemetry.tracer.startSpan('test')

    expect(telemetry.enabled).toBe(false)
    expect(span.isRecording()).toBe(false)

    span.end()
    await telemetry.shutdown()
  })

  it('builds stable low-cardinality resource identity for each process', () => {
    expect(createResourceAttributes(config, 'mailflow-core-worker')).toEqual({
      'service.name': 'mailflow-core-worker',
      'service.version': 'test-version',
      'deployment.environment.name': 'test',
      'service.instance.id': 'test-instance',
    })
  })
})
