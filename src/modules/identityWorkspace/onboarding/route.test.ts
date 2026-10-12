import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { expect, it, vi } from 'vitest'
import { installAuthRoutes } from '../infrastructure/auth/route.js'
import { SignupConflict } from './errors.js'
import { createOnboardingRoutes } from './route.js'

it('translates domain conflicts without interpreting database adapter errors', async () => {
  const signup = vi.fn().mockRejectedValueOnce(new SignupConflict())
  const app = createOnboardingRoutes({
    service: { signup },
    allowedOrigin: 'https://site.example.test',
    consumeBudget: async () => 0,
    handleOtp: async () => Response.json({}),
  })
  const errors = vi.fn()
  app.onError((error, context) => {
    errors(error)
    return context.json({ code: 'internal_error' }, 500)
  })
  const request = {
    method: 'POST',
    headers: {
      Origin: 'https://site.example.test',
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({
      name: 'Maya',
      email: 'maya@example.test',
      password: 'synthetic-password',
      workspaceName: 'Maya',
      workspaceSlug: 'maya',
    }),
  }
  const conflict = await app.request('/api/v1/onboarding/signup', request)
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ code: 'signup_unavailable' })
  const operational = Object.assign(new Error('private adapter details'), {
    code: '23505',
    constraint: 'user_pkey',
  })
  signup.mockRejectedValueOnce(operational)
  const failure = await app.request('/api/v1/onboarding/signup', request)
  expect(failure.status).toBe(500)
  expect(errors).toHaveBeenCalledWith(operational)
  expect(await failure.text()).not.toContain('private')
})

it('opens only the exact signup exception and leaves other v1 resources authenticated', async () => {
  const app = new Hono()
  const signup = vi.fn().mockResolvedValue({ status: 'verification-pending' })
  const onboarding = {
    closeLegacySignup: true,
    service: { signup },
    allowedOrigin: 'https://site.example.test',
    consumeBudget: async () => 0,
    handleOtp: async () => Response.json({ success: true }),
  }
  const auth = {
    handler: vi.fn().mockResolvedValue(Response.json({ success: true })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  }
  installAuthRoutes(app, { auth, allowedOrigins: [onboarding.allowedOrigin], onboarding })
  app.route('/', createOnboardingRoutes(onboarding))
  app.post('/api/v1/private', (context) => context.json({ protected: true }))
  const headers = {
    Origin: onboarding.allowedOrigin,
    'Content-Type': 'application/json',
    'Idempotency-Key': randomUUID(),
  }
  const body = JSON.stringify({
    name: 'Maya',
    email: 'maya@example.test',
    password: 'synthetic-password',
    workspaceName: 'Maya',
    workspaceSlug: 'maya',
  })
  const response = await app.request('/api/v1/onboarding/signup', { method: 'POST', headers, body })
  expect(response.status).toBe(202)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(signup).toHaveBeenCalledOnce()
  for (const path of ['/api/v1/private', '/api/v1/onboarding/signup/extra'])
    expect((await app.request(path, { method: 'POST', headers, body })).status).toBe(401)
  expect((await app.request('/api/v1/onboarding/signup', { headers })).status).toBe(401)
  expect(
    (await app.request('/api/auth/sign-up/email', { method: 'POST', headers, body })).status,
  ).toBe(404)
  expect(
    (await app.request('/api/auth/organization/create', { method: 'POST', headers, body })).status,
  ).toBe(404)
  expect(auth.handler).not.toHaveBeenCalled()
  expect(
    (
      await app.request('/api/v1/onboarding/signup', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://evil.test' },
        body,
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await app.request('/api/v1/onboarding/signup', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': 'bad-key' },
        body,
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await app.request('/api/v1/onboarding/signup', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'x'.repeat(5000) }),
      })
    ).status,
  ).toBe(413)
})

it('keeps legacy signup available before cutover and scopes the new payload limit to OTP', async () => {
  const app = new Hono()
  const handler = vi.fn(async () => Response.json({ delegated: true }))
  const handleOtp = vi.fn(async () => Response.json({ verified: true }))
  installAuthRoutes(app, {
    auth: { handler, api: { getSession: async () => null } },
    allowedOrigins: ['https://site.example.test'],
    onboarding: { handleOtp, closeLegacySignup: false },
  })
  const request = {
    method: 'POST',
    headers: { Origin: 'https://site.example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(5000) }),
  }
  expect((await app.request('/api/auth/sign-up/email', request)).status).toBe(200)
  expect((await app.request('/api/auth/reset-password', request)).status).toBe(200)
  expect((await app.request('/api/auth/email-otp/verify-email', request)).status).toBe(413)
  expect((await app.request('/api/auth/email-otp/check-verification-otp', request)).status).toBe(
    413,
  )
  expect(handler).toHaveBeenCalledTimes(2)
  expect(handleOtp).not.toHaveBeenCalled()
  const verification = await app.request('/api/auth/email-otp/verify-email', {
    ...request,
    body: JSON.stringify({ email: 'maya@example.test', otp: '123456' }),
  })
  expect(verification.status).toBe(200)
  expect(verification.headers.get('cache-control')).toBe('private, no-store')
  expect(handleOtp).toHaveBeenCalledOnce()
})
