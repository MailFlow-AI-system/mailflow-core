import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AccountEmailMessage,
  AccountEmailSender,
} from '../../accountEmails/accountEmailSender.js'
import { loadAuthConfig } from './authConfig.js'
import { createAuthOptions } from './createAuth.js'

const authConfig = loadAuthConfig({
  APP_ENV: 'development',
  BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
  BETTER_AUTH_URL: 'http://localhost:8080',
  SITE_URL: 'http://localhost:4321',
  WEB_APP_URL: 'http://localhost:3000',
  RESEND_API_KEY: 're_test_account_email_placeholder',
  RESEND_FROM_EMAIL: 'noreply@mailflow-ai.online',
})

function createTestAuth(
  rateLimitStorage: 'database' | 'memory' = 'database',
  ipAddressHeader = 'x-test-client-ip',
) {
  const sent: AccountEmailMessage[] = []
  const attempts: AccountEmailMessage[] = []
  const failures: string[] = []
  let rejectPasswordReset = false
  let rejectedPasswordResetRedirects = new Set<string>()
  let welcomeFailuresRemaining = 0
  const sendAccountEmail: AccountEmailSender = async (message) => {
    attempts.push(message)
    if (
      (message.kind === 'password-reset' &&
        (rejectPasswordReset ||
          rejectedPasswordResetRedirects.has(
            new URL(message.url).searchParams.get('callbackURL') ?? '',
          ))) ||
      (message.kind === 'verified-welcome' && welcomeFailuresRemaining > 0)
    ) {
      if (message.kind === 'verified-welcome') welcomeFailuresRemaining -= 1
      throw new Error('provider unavailable')
    }

    sent.push(message)
  }
  const options = createAuthOptions(authConfig, sendAccountEmail, (operation) =>
    failures.push(operation),
  )
  const auth = betterAuth({
    database: memoryAdapter({
      user: [],
      account: [],
      session: [],
      verification: [],
      rateLimit: [],
    }),
    ...options,
    rateLimit: { ...options.rateLimit, storage: rateLimitStorage },
    advanced: {
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: [ipAddressHeader] },
    },
  })
  const app = new Hono()
  app.all('/api/auth/*', (context) => auth.handler(context.req.raw))

  return {
    app,
    sent,
    attempts,
    failures,
    setRejectPasswordReset(value: boolean) {
      rejectPasswordReset = value
    },
    setRejectedPasswordResetRedirects(values: string[]) {
      rejectedPasswordResetRedirects = new Set(values)
    },
    setWelcomeFailures(value: number) {
      welcomeFailuresRemaining = value
    },
  }
}

function post(
  app: Hono,
  path: string,
  body: unknown,
  origin = authConfig.webAppURL,
  cookie?: string,
  clientIp = nextTestClientIp(),
) {
  return app.request(`http://localhost:8080/api/auth${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'x-test-client-ip': clientIp,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  })
}

let testClientIpSequence = 0

function nextTestClientIp() {
  testClientIpSequence += 1
  return `198.51.${Math.floor(testClientIpSequence / 256)}.${testClientIpSequence % 256}`
}

function findLast<T>(items: T[], predicate: (item: T) => boolean) {
  return [...items].reverse().find(predicate)
}

function cookieFrom(response: Response) {
  return response.headers.get('set-cookie')?.split(';')[0]
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Better Auth account email lifecycle', () => {
  it('uses persistent database rate limiting with a 60-second recovery rule', () => {
    const options = createAuthOptions(authConfig, async () => {})

    expect(options.rateLimit).toMatchObject({
      enabled: true,
      storage: 'database',
      customRules: { '/request-password-reset': { window: 60, max: 3 } },
    })
    expect(options.advanced.ipAddress.ipAddressHeaders).toEqual(['x-real-ip'])
  })

  it('requires a resent OTP, verifies without creating a session, and sends welcome once', async () => {
    const { app, sent } = createTestAuth()
    const email = 'signup@mailflow.invalid'
    const password = 'safe-test-password-123'
    const signUp = await post(app, '/sign-up/email', { name: 'MailFlow QA', email, password })

    expect(signUp.status).toBe(200)
    expect(signUp.headers.get('set-cookie')).toBeNull()
    expect(sent.filter((message) => message.kind === 'verification-otp')).toHaveLength(1)

    const unsupportedOtp = await post(app, '/email-otp/send-verification-otp', {
      email,
      type: 'sign-in',
    })
    expect(unsupportedOtp.status).toBe(200)
    expect(await unsupportedOtp.json()).toEqual({ success: true })
    expect(sent.filter((message) => message.kind === 'verification-otp')).toHaveLength(1)
    const passwordlessSignIn = await post(app, '/sign-in/email-otp', {
      email,
      otp: '000000',
    })
    expect(passwordlessSignIn.status).toBe(404)
    expect(passwordlessSignIn.headers.get('set-cookie')).toBeNull()
    for (const path of [
      '/email-otp/request-password-reset',
      '/email-otp/reset-password',
      '/forget-password/email-otp',
    ]) {
      const alternativeReset = await post(app, path, { email })
      expect(alternativeReset.status).toBe(404)
    }

    const blockedSignIn = await post(app, '/sign-in/email', { email, password })
    expect(blockedSignIn.ok).toBe(false)
    expect(blockedSignIn.headers.get('set-cookie')).toBeNull()

    const originalOtp = findLast(sent, (message) => message.kind === 'verification-otp')
    expect(originalOtp?.kind).toBe('verification-otp')
    const resend = await post(app, '/email-otp/send-verification-otp', {
      email,
      type: 'email-verification',
    })
    expect(resend.status).toBe(200)
    expect(await resend.json()).toEqual({ success: true })

    const latestOtp = findLast(sent, (message) => message.kind === 'verification-otp')
    expect(latestOtp?.kind).toBe('verification-otp')
    if (originalOtp?.kind !== 'verification-otp' || latestOtp?.kind !== 'verification-otp') {
      throw new Error('Expected verification OTP messages')
    }

    const invalid = await post(app, '/email-otp/verify-email', {
      email,
      otp: originalOtp.otp === latestOtp.otp ? '999999' : originalOtp.otp,
    })
    expect(invalid.status).toBe(400)

    const verified = await post(app, '/email-otp/verify-email', { email, otp: latestOtp.otp })
    expect(verified.status).toBe(200)
    expect(verified.headers.get('set-cookie')).toBeNull()
    expect(await verified.json()).toMatchObject({
      status: true,
      token: null,
      user: { email, emailVerified: true },
    })
    expect(sent.filter((message) => message.kind === 'verified-welcome')).toHaveLength(1)

    const signIn = await post(app, '/sign-in/email', { email, password })
    expect(signIn.status).toBe(200)
    expect(cookieFrom(signIn)).toBeDefined()

    await post(app, '/email-otp/send-verification-otp', {
      email,
      type: 'email-verification',
    })
    const repeatedOtp = findLast(sent, (message) => message.kind === 'verification-otp')
    if (repeatedOtp?.kind !== 'verification-otp') throw new Error('Expected verification OTP')
    const repeatedVerification = await post(app, '/email-otp/verify-email', {
      email,
      otp: repeatedOtp.otp,
    })
    expect(repeatedVerification.ok).toBe(false)
    expect(sent.filter((message) => message.kind === 'verified-welcome')).toHaveLength(1)
  })

  it('keeps password reset responses generic, consumes the token once, and revokes sessions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'))
    const { app, sent, attempts, failures, setRejectPasswordReset } = createTestAuth()
    const email = 'reset@mailflow.invalid'
    const signUp = await post(app, '/sign-up/email', {
      name: 'MailFlow QA',
      email,
      password: 'safe-test-password-123',
    })
    expect(signUp.status).toBe(200)
    const otp = findLast(sent, (message) => message.kind === 'verification-otp')
    if (otp?.kind !== 'verification-otp') throw new Error('Expected verification OTP')
    await post(app, '/email-otp/verify-email', { email, otp: otp.otp })

    const session = await post(app, '/sign-in/email', {
      email,
      password: 'safe-test-password-123',
    })
    const sessionCookie = cookieFrom(session)
    expect(session.status).toBe(200)
    expect(sessionCookie).toBeDefined()

    setRejectPasswordReset(true)
    const knownEmailReset = await post(app, '/request-password-reset', {
      email,
      redirectTo: `${authConfig.webAppURL}/reset-password`,
    })
    const unknownEmailReset = await post(app, '/request-password-reset', {
      email: 'unknown@mailflow.invalid',
      redirectTo: `${authConfig.webAppURL}/reset-password`,
    })
    expect(knownEmailReset.status).toBe(503)
    const failedResetBody = await knownEmailReset.json()
    expect(failedResetBody).toMatchObject({ code: 'PASSWORD_RESET_EMAIL_DELIVERY_FAILED' })
    expect(JSON.stringify(failedResetBody)).not.toContain(email)
    expect(JSON.stringify(failedResetBody)).not.toContain('safe-test-password-123')
    expect(unknownEmailReset.status).toBe(404)
    const unknownResetBody = await unknownEmailReset.json()
    expect(unknownResetBody).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' })
    expect(JSON.stringify(unknownResetBody)).not.toContain('unknown@mailflow.invalid')
    expect(attempts.filter((message) => message.kind === 'password-reset')).toHaveLength(1)
    expect(failures).toEqual(['password-reset'])
    vi.advanceTimersByTime(60_000)

    const failedResetEmail = findLast(attempts, (message) => message.kind === 'password-reset')
    if (failedResetEmail?.kind !== 'password-reset') {
      throw new Error('Expected a failed password reset email attempt')
    }
    const failedResetUrl = new URL(failedResetEmail.url)
    const failedResetCallback = await app.request(
      `${failedResetUrl.pathname}${failedResetUrl.search}`,
    )
    const failedResetLocation = new URL(failedResetCallback.headers.get('location') ?? '')
    expect(failedResetLocation.searchParams.get('error')).toBe('INVALID_TOKEN')
    expect(failedResetLocation.searchParams.has('token')).toBe(false)

    setRejectPasswordReset(false)
    const resetRequest = await post(app, '/request-password-reset', {
      email,
      redirectTo: `${authConfig.webAppURL}/reset-password`,
    })
    expect(resetRequest.status).toBe(200)
    expect(await resetRequest.json()).toMatchObject({ status: true })
    const resetEmail = findLast(sent, (message) => message.kind === 'password-reset')
    if (resetEmail?.kind !== 'password-reset') throw new Error('Expected password reset email')

    const resetUrl = new URL(resetEmail.url)
    const callback = await app.request(`${resetUrl.pathname}${resetUrl.search}`)
    expect(callback.status).toBe(302)
    const callbackLocation = new URL(callback.headers.get('location') ?? '')
    expect(callbackLocation.origin).toBe(authConfig.webAppURL)
    expect(callbackLocation.pathname).toBe('/reset-password')
    expect(callbackLocation.searchParams.get('token')).toBe(resetUrl.pathname.split('/').at(-1))

    const samePasswordReset = await post(app, '/reset-password', {
      token: resetUrl.pathname.split('/').at(-1),
      newPassword: 'safe-test-password-123',
    })
    expect(samePasswordReset.status).toBe(400)
    expect(await samePasswordReset.json()).toMatchObject({ code: 'PASSWORD_ALREADY_IN_USE' })

    const sessionAfterRejectedReset = await app.request(
      'http://localhost:8080/api/auth/get-session',
      {
        headers: { Cookie: sessionCookie ?? '' },
      },
    )
    expect(await sessionAfterRejectedReset.json()).not.toBeNull()

    const reset = await post(app, '/reset-password', {
      token: resetUrl.pathname.split('/').at(-1),
      newPassword: 'safe-new-password-456',
    })
    expect(reset.status).toBe(200)
    expect(await reset.json()).toEqual({ status: true })

    const reusedToken = await post(app, '/reset-password', {
      token: resetUrl.pathname.split('/').at(-1),
      newPassword: 'safe-another-password-789',
    })
    expect(reusedToken.status).toBe(400)

    const oldSession = await app.request('http://localhost:8080/api/auth/get-session', {
      headers: { Cookie: sessionCookie ?? '' },
    })
    expect(await oldSession.json()).toBeNull()

    const signInWithOldPassword = await post(app, '/sign-in/email', {
      email,
      password: 'safe-test-password-123',
    })
    expect(signInWithOldPassword.ok).toBe(false)
    const signInWithNewPassword = await post(app, '/sign-in/email', {
      email,
      password: 'safe-new-password-456',
    })
    expect(signInWithNewPassword.status).toBe(200)
  })

  it('limits concurrent recovery requests to three per trusted IP and ignores forged forwarded IPs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'))
    const { app } = createTestAuth('memory', 'x-real-ip')
    const email = 'unknown-rate-limited@mailflow.invalid'
    const requestWithSpoofedForwardedIp = (forwardedIp: string) =>
      app.request('http://localhost:8080/api/auth/request-password-reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: authConfig.webAppURL,
          'x-real-ip': '192.0.2.88',
          'x-forwarded-for': forwardedIp,
        },
        body: JSON.stringify({
          email,
          redirectTo: `${authConfig.webAppURL}/reset-password`,
        }),
      })
    const concurrentAttempts = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        requestWithSpoofedForwardedIp(`198.51.100.${index + 1}`),
      ),
    )
    expect(concurrentAttempts.map((response) => response.status).sort()).toEqual([
      404, 404, 404, 429,
    ])
    const concurrentLimit = concurrentAttempts.find((response) => response.status === 429)
    expect(concurrentLimit?.headers.get('x-retry-after')).toBe('60')
    expect(await concurrentLimit?.json()).toMatchObject({
      message: 'Too many requests. Please try again later.',
    })

    vi.advanceTimersByTime(59_000)
    const prematureRetry = await requestWithSpoofedForwardedIp('198.51.100.5')
    expect(prematureRetry.status).toBe(429)
    expect(prematureRetry.headers.get('x-retry-after')).toBe('1')

    vi.advanceTimersByTime(1_000)
    const retryAfterWindow = await requestWithSpoofedForwardedIp('198.51.100.6')
    expect(retryAfterWindow.status).toBe(404)
  })

  it('limits recovery requests to one per account for 60 seconds across client IPs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'))
    const { app, sent, setRejectPasswordReset } = createTestAuth()
    const email = 'account-rate-limited@mailflow.invalid'
    const signUp = await post(app, '/sign-up/email', {
      name: 'MailFlow QA',
      email,
      password: 'safe-test-password-123',
    })
    expect(signUp.status).toBe(200)
    const otp = findLast(sent, (message) => message.kind === 'verification-otp')
    if (otp?.kind !== 'verification-otp') throw new Error('Expected verification OTP')
    await post(app, '/email-otp/verify-email', { email, otp: otp.otp })

    setRejectPasswordReset(true)
    const failedDelivery = await post(
      app,
      '/request-password-reset',
      { email, redirectTo: `${authConfig.webAppURL}/reset-password` },
      authConfig.webAppURL,
      undefined,
      '192.0.2.10',
    )
    expect(failedDelivery.status).toBe(503)

    setRejectPasswordReset(false)
    const otherIpAttempt = await post(
      app,
      '/request-password-reset',
      { email, redirectTo: `${authConfig.webAppURL}/reset-password` },
      authConfig.webAppURL,
      undefined,
      '192.0.2.11',
    )
    expect(otherIpAttempt.status).toBe(429)
    expect(otherIpAttempt.headers.get('x-retry-after')).toBe('60')
    const limitedBody = await otherIpAttempt.json()
    expect(limitedBody).toMatchObject({
      code: 'PASSWORD_RESET_RATE_LIMITED',
      message: 'Please wait before requesting another recovery link.',
    })
    expect(JSON.stringify(limitedBody)).not.toContain(email)

    vi.advanceTimersByTime(60_000)
    const retry = await post(
      app,
      '/request-password-reset',
      { email, redirectTo: `${authConfig.webAppURL}/reset-password` },
      authConfig.webAppURL,
      undefined,
      '192.0.2.11',
    )
    expect(retry.status).toBe(200)
  })

  it('isolates concurrent recovery results and revokes only the failed delivery token', async () => {
    const { app, sent, attempts, setRejectedPasswordResetRedirects } = createTestAuth()
    const email = 'concurrent-reset@mailflow.invalid'
    const successfulEmailAddress = 'concurrent-reset-success@mailflow.invalid'
    const signUp = await post(app, '/sign-up/email', {
      name: 'MailFlow QA',
      email,
      password: 'safe-test-password-123',
    })
    expect(signUp.status).toBe(200)
    const otp = findLast(sent, (message) => message.kind === 'verification-otp')
    if (otp?.kind !== 'verification-otp') throw new Error('Expected verification OTP')
    await post(app, '/email-otp/verify-email', { email, otp: otp.otp })

    const successfulSignUp = await post(app, '/sign-up/email', {
      name: 'MailFlow QA',
      email: successfulEmailAddress,
      password: 'safe-test-password-123',
    })
    expect(successfulSignUp.status).toBe(200)
    const successfulOtp = findLast(
      sent,
      (message) => message.kind === 'verification-otp' && message.to === successfulEmailAddress,
    )
    if (successfulOtp?.kind !== 'verification-otp') {
      throw new Error('Expected verification OTP for the second account')
    }
    await post(app, '/email-otp/verify-email', {
      email: successfulEmailAddress,
      otp: successfulOtp.otp,
    })

    const untrustedRedirect = await post(app, '/request-password-reset', {
      email: 'unknown@mailflow.invalid',
      redirectTo: 'https://attacker.invalid/reset-password',
    })
    expect(untrustedRedirect.status).toBe(403)
    const untrustedOrigin = await post(
      app,
      '/request-password-reset',
      { email: 'unknown@mailflow.invalid', redirectTo: `${authConfig.webAppURL}/reset-password` },
      'https://attacker.invalid',
      'session=present',
    )
    expect(untrustedOrigin.status).toBe(403)

    const failedCallback = `${authConfig.webAppURL}/reset-password?case=failed`
    const successfulCallback = `${authConfig.webAppURL}/reset-password?case=successful`
    setRejectedPasswordResetRedirects([failedCallback])
    const [failed, successful] = await Promise.all([
      post(app, '/request-password-reset', { email, redirectTo: failedCallback }),
      post(app, '/request-password-reset', {
        email: successfulEmailAddress,
        redirectTo: successfulCallback,
      }),
    ])

    expect(failed.status).toBe(503)
    expect(await failed.json()).toMatchObject({ code: 'PASSWORD_RESET_EMAIL_DELIVERY_FAILED' })
    expect(successful.status).toBe(200)
    expect(await successful.json()).toMatchObject({ status: true })

    const resetEmails = attempts.filter((message) => message.kind === 'password-reset')
    expect(resetEmails).toHaveLength(2)
    const failedEmail = resetEmails.find(
      (message) =>
        message.kind === 'password-reset' &&
        new URL(message.url).searchParams.get('callbackURL') === failedCallback,
    )
    const successfulEmail = resetEmails.find(
      (message) =>
        message.kind === 'password-reset' &&
        message.to === successfulEmailAddress &&
        new URL(message.url).searchParams.get('callbackURL') === successfulCallback,
    )
    if (failedEmail?.kind !== 'password-reset' || successfulEmail?.kind !== 'password-reset') {
      throw new Error('Expected both concurrent password reset email attempts')
    }

    const failedReset = await app.request(
      `${new URL(failedEmail.url).pathname}${new URL(failedEmail.url).search}`,
    )
    expect(new URL(failedReset.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'INVALID_TOKEN',
    )

    const successfulReset = await app.request(
      `${new URL(successfulEmail.url).pathname}${new URL(successfulEmail.url).search}`,
    )
    const successfulLocation = new URL(successfulReset.headers.get('location') ?? '')
    expect(successfulLocation.searchParams.get('case')).toBe('successful')
    expect(successfulLocation.searchParams.get('token')).toBeDefined()
    expect(successfulLocation.searchParams.has('error')).toBe(false)
  })

  it('keeps verification successful when the welcome email provider fails', async () => {
    const { app, sent, attempts, failures, setWelcomeFailures } = createTestAuth()
    const email = 'welcome-failure@mailflow.invalid'
    const signUp = await post(app, '/sign-up/email', {
      name: 'MailFlow QA',
      email,
      password: 'safe-test-password-123',
    })
    expect(signUp.status).toBe(200)
    const otp = findLast(sent, (message) => message.kind === 'verification-otp')
    if (otp?.kind !== 'verification-otp') throw new Error('Expected verification OTP')

    setWelcomeFailures(2)
    const verified = await post(app, '/email-otp/verify-email', { email, otp: otp.otp })

    expect(verified.status).toBe(200)
    expect(await verified.json()).toMatchObject({
      status: true,
      token: null,
      user: { email, emailVerified: true },
    })
    expect(attempts.filter((message) => message.kind === 'verified-welcome')).toHaveLength(2)
    expect(sent.filter((message) => message.kind === 'verified-welcome')).toHaveLength(0)
    expect(failures).toEqual(['account-welcome'])
  })

  it('retries a failed welcome email once with the same account event', async () => {
    const { app, sent, attempts, failures, setWelcomeFailures } = createTestAuth()
    const email = 'welcome-retry@mailflow.invalid'
    const signUp = await post(app, '/sign-up/email', {
      name: 'MailFlow QA',
      email,
      password: 'safe-test-password-123',
    })
    expect(signUp.status).toBe(200)
    const otp = findLast(sent, (message) => message.kind === 'verification-otp')
    if (otp?.kind !== 'verification-otp') throw new Error('Expected verification OTP')

    setWelcomeFailures(1)
    const verified = await post(app, '/email-otp/verify-email', { email, otp: otp.otp })

    expect(verified.status).toBe(200)
    expect(attempts.filter((message) => message.kind === 'verified-welcome')).toHaveLength(2)
    expect(attempts.filter((message) => message.kind === 'verified-welcome')[0]).toEqual(
      attempts.filter((message) => message.kind === 'verified-welcome')[1],
    )
    expect(sent.filter((message) => message.kind === 'verified-welcome')).toHaveLength(1)
    expect(failures).toEqual([])
  })

  it('rejects expired verification OTPs and password reset tokens', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'))
    const { app, sent } = createTestAuth()
    const email = 'expired@mailflow.invalid'
    const signUp = await post(app, '/sign-up/email', {
      name: 'MailFlow QA',
      email,
      password: 'safe-test-password-123',
    })
    expect(signUp.status).toBe(200)
    const otp = findLast(sent, (message) => message.kind === 'verification-otp')
    if (otp?.kind !== 'verification-otp') throw new Error('Expected verification OTP')

    vi.setSystemTime(new Date('2026-09-28T12:06:00.000Z'))
    const expiredOtp = await post(app, '/email-otp/verify-email', { email, otp: otp.otp })
    expect(expiredOtp.status).toBe(400)

    const resetRequest = await post(app, '/request-password-reset', {
      email,
      redirectTo: `${authConfig.webAppURL}/reset-password`,
    })
    expect(resetRequest.status).toBe(200)
    const resetEmail = findLast(sent, (message) => message.kind === 'password-reset')
    if (resetEmail?.kind !== 'password-reset') throw new Error('Expected password reset email')

    vi.setSystemTime(new Date('2026-09-28T13:06:01.000Z'))
    const expiredReset = await post(app, '/reset-password', {
      token: new URL(resetEmail.url).pathname.split('/').at(-1),
      newPassword: 'safe-new-password-456',
    })
    expect(expiredReset.status).toBe(400)
  })
})
