import type { MiddlewareHandler } from 'hono'
import type { Logger } from 'pino'

export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (context, next) => {
    const startedAt = performance.now()

    try {
      await next()
    } finally {
      logger.info(
        {
          requestId: context.get('requestId'),
          method: context.req.method,
          path: context.req.path,
          status: context.res.status,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'Request completed',
      )
    }
  }
}
