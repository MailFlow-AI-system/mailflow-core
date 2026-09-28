import {
  type Attributes,
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

const durationHistogramBoundaries = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
]

export function requestLogger(logger: Logger, observability: Observability): MiddlewareHandler {
  const requestDuration: Histogram = observability.meter.createHistogram(
    'http.server.request.duration',
    {
      description: 'HTTP request duration.',
      unit: 's',
      advice: {
        explicitBucketBoundaries: durationHistogramBoundaries,
      },
    },
  )
  const authOperationCount = observability.meter.createCounter('mailflow.auth.operation.count', {
    description: 'Authentication operations completed.',
    unit: '{operation}',
  })
  const authOperationDuration: Histogram = observability.meter.createHistogram(
    'mailflow.auth.operation.duration',
    {
      description: 'Authentication operation duration.',
      unit: 's',
      advice: {
        explicitBucketBoundaries: durationHistogramBoundaries,
      },
    },
  )
  const tracer: Tracer = observability.tracer

  return async (honoContext, next) => {
    const startedAt = performance.now()
    const initialRoute = honoContext.req.routePath || 'unknown'
    const method = honoContext.req.method
    const authOperation = getAuthOperation(method, honoContext.req.url)
    let requestFailed = false
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
        requestFailed = true
        span.recordException({
          name: error instanceof Error ? error.name : 'UnknownError',
        })
        span.setStatus({ code: SpanStatusCode.ERROR })
        throw error
      } finally {
        const durationSeconds = (performance.now() - startedAt) / 1000
        const durationMs = Math.round(durationSeconds * 1000)
        const status = honoContext.res.status
        const route = honoContext.req.routePath || initialRoute
        const attributes: Attributes = {
          'http.request.method': method,
          'http.route': route,
          'http.response.status_code': status,
          'url.scheme': new URL(honoContext.req.url).protocol.slice(0, -1),
          ...(status >= 500 ? { 'error.type': String(status) } : {}),
        }

        span.updateName(`${method} ${route}`)
        span.setAttribute('http.route', route)
        span.setAttribute('http.response.status_code', status)
        requestDuration.record(durationSeconds, attributes)
        if (authOperation !== undefined) {
          const authResult = requestFailed
            ? 'unavailable'
            : await classifyAuthResult(authOperation, status, honoContext.res)
          const authAttributes = {
            'mailflow.auth.operation': authOperation,
            'mailflow.auth.result': authResult,
          }
          authOperationCount.add(1, authAttributes)
          authOperationDuration.record(durationSeconds, authAttributes)
          span.setAttributes(authAttributes)
        }
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

type AuthOperation = 'sign_up' | 'sign_in' | 'sign_out' | 'session_check'
type AuthResult = 'success' | 'rejected' | 'failure' | 'unavailable'

function getAuthOperation(method: string, requestUrl: string): AuthOperation | undefined {
  const path = new URL(requestUrl).pathname
  switch (`${method} ${path}`) {
    case 'POST /api/auth/sign-up/email':
      return 'sign_up'
    case 'POST /api/auth/sign-in/email':
      return 'sign_in'
    case 'POST /api/auth/sign-out':
      return 'sign_out'
    case 'GET /api/auth/get-session':
      return 'session_check'
    default:
      return undefined
  }
}

async function classifyAuthResult(
  operation: AuthOperation,
  status: number,
  response: Response,
): Promise<AuthResult> {
  if (status >= 500) return 'unavailable'
  if (status >= 400) return 'rejected'
  if (status < 200 || status >= 300) return 'failure'
  if (operation !== 'session_check') return 'success'

  try {
    return (await response.clone().json()) === null ? 'rejected' : 'success'
  } catch {
    return 'failure'
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
