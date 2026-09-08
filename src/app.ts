import { swaggerUI } from '@hono/swagger-ui'
import { OpenAPIHono } from '@hono/zod-openapi'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import type { Logger } from 'pino'

import { createHealthModule } from '#modules/system'
import type { AppConfig } from '#shared/config/env'
import { problemDetailsResponse } from '#shared/http/problemDetails'
import { requestLogger } from '#shared/http/requestLogger'

type AppDependencies = {
  config: AppConfig
  logger: Logger
  checkDatabase: () => Promise<void>
}

export function createApp({ config, logger, checkDatabase }: AppDependencies) {
  const app = new OpenAPIHono()

  app.use('*', requestId())
  app.use('*', secureHeaders())
  app.use('*', requestLogger(logger))

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
    logger.error(
      {
        requestId: context.get('requestId'),
        method: context.req.method,
        path: context.req.path,
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
