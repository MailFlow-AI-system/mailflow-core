import { once } from 'node:events'
import { trace } from '@opentelemetry/api'
import pino from 'pino'

import type { AppConfig } from '#shared/config/env'
import { createResourceAttributes } from '#shared/observability/observability'

const redactedPaths = [
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  'cookie',
  'headers.cookie',
  'req.headers.cookie',
  'set-cookie',
  'headers.set-cookie',
  'req.headers.set-cookie',
  'databaseUrl',
  'DATABASE_URL',
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'email',
  'subject',
  'body',
  'payload',
]

const otlpTransports = new WeakMap<pino.Logger, ReturnType<typeof pino.transport>>()

export function createLogger(config: AppConfig, serviceName = 'mailflow-core-api') {
  const streams: pino.StreamEntry[] = [
    { stream: process.stdout as unknown as pino.DestinationStream },
  ]
  let otlpTransport: ReturnType<typeof pino.transport> | undefined

  if (config.otlpEndpoint !== undefined) {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= config.otlpEndpoint
    otlpTransport = pino.transport({
      target: 'pino-opentelemetry-transport',
      options: {
        loggerName: serviceName,
        serviceVersion: config.serviceVersion,
        resourceAttributes: createResourceAttributes(config, serviceName),
      },
    })
    streams.push({
      stream: otlpTransport,
    })
  }

  const logger = pino(
    {
      name: serviceName,
      level: config.logLevel,
      base: {
        service: serviceName,
        environment: config.appEnv,
        version: config.serviceVersion,
      },
      redact: {
        paths: redactedPaths,
        censor: '[REDACTED]',
      },
      mixin: () => {
        const span = trace.getActiveSpan()
        if (span === undefined || !span.isRecording()) {
          return {}
        }

        const spanContext = span.spanContext()
        return {
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
        }
      },
    },
    pino.multistream(streams),
  )
  if (otlpTransport !== undefined) otlpTransports.set(logger, otlpTransport)
  return logger
}

export async function shutdownLogger(logger: pino.Logger): Promise<void> {
  const transport = otlpTransports.get(logger)
  if (transport === undefined) return

  otlpTransports.delete(logger)
  const closed = once(transport, 'close')
  transport.end()
  await closed
}
