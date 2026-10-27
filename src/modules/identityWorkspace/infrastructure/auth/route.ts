import type { Env, Hono, Schema } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'

import { problemDetailsResponse } from '#shared/http/problemDetails'
import type { AuthRouteDependencies } from '../types/auth.js'
import type {} from '../types/authContext.js'
import { ONBOARDING_OTP_PATHS } from './routeConstants.js'

export function installAuthRoutes<E extends Env, S extends Schema, BasePath extends string>(
  app: Hono<E, S, BasePath>,
  {
    auth,
    allowedOrigins,
    isAllowedOrigin = (origin) => allowedOrigins.includes(origin),
    onboarding,
  }: AuthRouteDependencies,
) {
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (isAllowedOrigin(origin) ? origin : undefined),
      credentials: true,
      allowHeaders: [
        'Content-Type',
        'X-Workspace-Identity',
        'X-Workspace-Id',
        'traceparent',
        'tracestate',
        ...(onboarding ? ['Idempotency-Key'] : []),
      ],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      exposeHeaders: ['X-Workspace-Identity', 'Retry-After'],
    }),
  )

  if (onboarding) {
    const limitOtpBody = bodyLimit({
      maxSize: 4096,
      onError: (context) =>
        problemDetailsResponse(context, {
          title: 'Payload too large',
          status: 413,
          detail: 'The authentication request is too large.',
          code: 'auth_payload_too_large',
        }),
    })
    app.use('/api/auth/*', async (context, next) => {
      context.header('Cache-Control', 'private, no-store')
      const path = decodeURIComponent(new URL(context.req.url).pathname).replace(/\/$/, '')
      if (context.req.method === 'POST' && ONBOARDING_OTP_PATHS.includes(path))
        return limitOtpBody(context, next)
      await next()
    })
  }
  app.all('/api/auth/*', (context) => {
    const path = decodeURIComponent(new URL(context.req.url).pathname).replace(/\/$/, '')
    if (
      /^\/api\/auth\/organization(?:\/|$)/.test(path) ||
      (onboarding?.closeLegacySignup && /^\/api\/auth\/sign-up\/email\/?$/.test(path))
    ) {
      return problemDetailsResponse(context, {
        title: 'Not Found',
        status: 404,
        detail: 'The requested route does not exist.',
        code: 'route_not_found',
      })
    }
    if (onboarding && context.req.method === 'POST' && ONBOARDING_OTP_PATHS.includes(path))
      return onboarding.handleOtp(context.req.raw)
    return auth.handler(context.req.raw)
  })

  app.use('/api/v1/*', async (context, next) => {
    context.header('Cache-Control', 'private, no-store')
    if (
      onboarding &&
      context.req.method === 'POST' &&
      context.req.path === '/api/v1/onboarding/signup'
    ) {
      await next()
      return
    }
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
