import { OpenAPIHono } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { problemDetailsResponse } from '#shared/http/problemDetails'
import { signupRoute } from './contract.js'
import { SignupConflict } from './errors.js'
import type { OnboardingRouteDependencies } from './types.js'
import { isUniqueViolation } from './utils/uniqueViolation.js'

export function createOnboardingRoutes({
  service,
  allowedOrigin,
  consumeBudget,
}: OnboardingRouteDependencies) {
  const app = new OpenAPIHono({
    defaultHook: (result, context) => {
      if (!result.success)
        return problemDetailsResponse(context, {
          title: 'Invalid request',
          status: 400,
          detail: 'Check the signup fields and idempotency key.',
          code: 'invalid_signup_request',
        })
    },
  })
  app.use('/api/v1/onboarding/signup', async (context, next) => {
    context.header('Cache-Control', 'private, no-store')
    if (context.req.header('Origin') !== allowedOrigin)
      return problemDetailsResponse(context, {
        title: 'Forbidden',
        status: 403,
        detail: 'This signup origin is not allowed.',
        code: 'signup_origin_denied',
      })
    if (context.req.header('Content-Type')?.split(';')[0]?.trim() !== 'application/json')
      return problemDetailsResponse(context, {
        title: 'Invalid request',
        status: 400,
        detail: 'Use a JSON signup request.',
        code: 'invalid_signup_request',
      })
    await next()
  })
  app.use(
    '/api/v1/onboarding/signup',
    bodyLimit({
      maxSize: 4096,
      onError: (context) =>
        problemDetailsResponse(context, {
          title: 'Payload too large',
          status: 413,
          detail: 'The signup request is too large.',
          code: 'signup_payload_too_large',
        }),
    }),
  )
  app.openapi(signupRoute, async (context) => {
    const input = context.req.valid('json')
    const retryAfter = await consumeBudget(input.email)
    if (retryAfter) {
      context.header('Retry-After', String(retryAfter))
      return problemDetailsResponse(context, {
        title: 'Too many requests',
        status: 429,
        detail: 'Please wait before retrying signup.',
        code: 'signup_rate_limited',
      })
    }
    try {
      return context.json(
        await service.signup(input, context.req.valid('header')['idempotency-key']),
        202,
      )
    } catch (error) {
      if (error instanceof SignupConflict || isUniqueViolation(error))
        return problemDetailsResponse(context, {
          title: 'Signup unavailable',
          status: 409,
          detail: 'Check your details or request verification for an existing account.',
          code: 'signup_unavailable',
        })
      throw error
    }
  })
  return app
}
