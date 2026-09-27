import type { Env, Hono, Schema } from 'hono'
import { cors } from 'hono/cors'

import { problemDetailsResponse } from '#shared/http/problemDetails'

export type AuthSession = {
  session: { id: string }
  user: { id: string }
}

export type AuthService = {
  handler: (request: Request) => Response | Promise<Response>
  api: {
    getSession: (input: { headers: Headers }) => Promise<AuthSession | null>
  }
}

type AuthRouteDependencies = {
  auth: AuthService
  allowedOrigins: string[]
}

export function installAuthRoutes<E extends Env, S extends Schema, BasePath extends string>(
  app: Hono<E, S, BasePath>,
  { auth, allowedOrigins }: AuthRouteDependencies,
) {
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (allowedOrigins.includes(origin) ? origin : undefined),
      credentials: true,
      allowHeaders: ['Content-Type'],
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
