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

export function createLogger(config: AppConfig, serviceName = 'mailflow-core-api') {
  const streams: pino.StreamEntry[] = [
    { stream: process.stdout as unknown as pino.DestinationStream },
  ]

  if (config.otlpEndpoint !== undefined) {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= config.otlpEndpoint
    streams.push({
      stream: pino.transport({
        target: 'pino-opentelemetry-transport',
        options: {
          loggerName: serviceName,
          serviceVersion: config.serviceVersion,
          resourceAttributes: createResourceAttributes(config, serviceName),
        },
      }),
    })
  }

  return pino(
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
}

export function flushLogger(logger: Pick<pino.Logger, 'flush'>): Promise<void> {
  return new Promise((resolve) => logger.flush(() => resolve()))
}
