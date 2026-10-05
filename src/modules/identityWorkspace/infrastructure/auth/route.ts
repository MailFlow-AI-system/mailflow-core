import type { Env, Hono, Schema } from 'hono'
import { cors } from 'hono/cors'

import { problemDetailsResponse } from '#shared/http/problemDetails'
import type { AuthRouteDependencies } from '../types/auth.js'
import type {} from '../types/authContext.js'

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

  app.all('/api/auth/*', (context) => {
    const path = decodeURIComponent(new URL(context.req.url).pathname)
    if (/^\/api\/auth\/organization(?:\/|$)/.test(path)) {
      return problemDetailsResponse(context, {
        title: 'Not Found',
        status: 404,
        detail: 'The requested route does not exist.',
        code: 'route_not_found',
      })
    }
    return auth.handler(context.req.raw)
  })

  app.use('/api/v1/*', async (context, next) => {
    context.header('Cache-Control', 'private, no-store')
    const session = await auth.api.getSession({ headers: context.req.raw.headers })

    if (!session) {
      return problemDetailsResponse(context, {
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication is required to access this resource.',
        code: 'authentication_required',
      })
    }

    context.set('authSession', session)
    await next()
  })
}
