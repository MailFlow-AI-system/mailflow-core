import { swaggerUI } from '@hono/swagger-ui'
import { OpenAPIHono } from '@hono/zod-openapi'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import type { Logger } from 'pino'

import { createHealthModule } from '#modules/system'
import type { AppConfig } from '#shared/config/env'
import { problemDetailsResponse } from '#shared/http/problemDetails'
import { requestLogger } from '#shared/http/requestLogger'
import { createNoopObservability, type Observability } from '#shared/observability/observability'

type AppDependencies = {
  config: AppConfig
  logger: Logger
  checkDatabase: () => Promise<void>
  observability?: Observability
}

export function createApp({
  config,
  logger,
  checkDatabase,
  observability = createNoopObservability('mailflow-core-api'),
}: AppDependencies) {
  const app = new OpenAPIHono()

  app.use('*', requestId(), secureHeaders(), requestLogger(logger, observability))

  app.route('/', createHealthModule({ checkDatabase }))

  if (config.apiDocsEnabled) {
    app.doc('/openapi.json', {
      openapi: '3.1.0',
      info: {
        title: 'MailFlow Core API',
        version: config.serviceVersion,
      },
    })
    app.get('/docs', swaggerUI({ url: '/openapi.json' }))
  }

  app.notFound((context) =>
    problemDetailsResponse(context, {
      title: 'Not Found',
      status: 404,
      detail: 'The requested route does not exist.',
      code: 'route_not_found',
    }),
  )

  app.onError((error, context) => {
    const activeSpan = trace.getActiveSpan()
    activeSpan?.recordException({
      name: error instanceof Error ? error.name : 'UnknownError',
    })
    activeSpan?.setStatus({ code: SpanStatusCode.ERROR })
    logger.error(
      {
        requestId: context.get('requestId'),
        method: context.req.method,
        route: context.req.routePath || 'unknown',
        errorName: error.name,
      },
      'Unhandled request error',
    )

    return problemDetailsResponse(context, {
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred.',
      code: 'internal_error',
    })
  })

  return app
}
