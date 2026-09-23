import {
  type Attributes,
  type Counter,
  type Histogram,
  context as otelContext,
  propagation,
  SpanStatusCode,
  type TextMapGetter,
  type Tracer,
  trace,
} from '@opentelemetry/api'
import type { MiddlewareHandler } from 'hono'
import type { Logger } from 'pino'

import type { Observability } from '../observability/observability.js'

export function requestLogger(logger: Logger, observability: Observability): MiddlewareHandler {
  const requestCount: Counter = observability.meter.createCounter('http.server.request.count', {
    description: 'Completed HTTP requests.',
    unit: '{request}',
  })
  const requestDuration: Histogram = observability.meter.createHistogram(
    'http.server.request.duration',
    {
      description: 'HTTP request duration.',
      unit: 'ms',
    },
  )
  const tracer: Tracer = observability.tracer

  return async (honoContext, next) => {
    const startedAt = performance.now()
    const initialRoute = honoContext.req.routePath || 'unknown'
    const method = honoContext.req.method
    const parentContext = propagation.extract(
      otelContext.active(),
      honoContext.req.raw.headers,
      requestHeadersGetter,
    )
    const span = tracer.startSpan(
      `${method} ${initialRoute}`,
      {
        attributes: {
          'http.request.method': method,
          'mailflow.request.id': honoContext.get('requestId'),
        },
      },
      parentContext,
    )

    return otelContext.with(trace.setSpan(parentContext, span), async () => {
      try {
        await next()
      } catch (error) {
        span.recordException({
          name: error instanceof Error ? error.name : 'UnknownError',
        })
        span.setStatus({ code: SpanStatusCode.ERROR })
        throw error
      } finally {
        const durationMs = Math.round(performance.now() - startedAt)
        const status = honoContext.res.status
        const route = honoContext.req.routePath || initialRoute
        const attributes: Attributes = {
          'http.request.method': method,
          'http.route': route,
          'http.response.status_code': status,
        }

        span.updateName(`${method} ${route}`)
        span.setAttribute('http.route', route)
        span.setAttribute('http.response.status_code', status)
        requestCount.add(1, attributes)
        requestDuration.record(durationMs, {
          'http.request.method': method,
          'http.route': route,
        })
        if (status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR })
        }
        const spanContext = span.spanContext()
        const correlation = span.isRecording()
          ? { traceId: spanContext.traceId, spanId: spanContext.spanId }
          : {}
        span.end()

        logger.info(
          {
            requestId: honoContext.get('requestId'),
            method,
            route,
            status,
            durationMs,
            ...correlation,
          },
          'Request completed',
        )
      }
    })
  }
}

const requestHeadersGetter: TextMapGetter<Headers> = {
  get(carrier, key) {
    return carrier.get(key) ?? undefined
  },
  keys(carrier) {
    return [...carrier.keys()]
  },
}
