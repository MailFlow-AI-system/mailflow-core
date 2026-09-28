import type { Env, Hono, Schema } from 'hono'
import { cors } from 'hono/cors'

import { problemDetailsResponse } from '#shared/http/problemDetails'
import type { AuthRouteDependencies } from '../types/auth.js'

export function installAuthRoutes<E extends Env, S extends Schema, BasePath extends string>(
  app: Hono<E, S, BasePath>,
  { auth, allowedOrigins }: AuthRouteDependencies,
) {
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (allowedOrigins.includes(origin) ? origin : undefined),
      credentials: true,
      allowHeaders: ['Content-Type', 'traceparent', 'tracestate'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
    }),
  )

  app.all('/api/auth/*', (context) => auth.handler(context.req.raw))

  app.use('/api/v1/*', async (context, next) => {
    const session = await auth.api.getSession({ headers: context.req.raw.headers })

    if (!session) {
      return problemDetailsResponse(context, {
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication is required to access this resource.',
        code: 'authentication_required',
      })
    }

    await next()
  })
}
