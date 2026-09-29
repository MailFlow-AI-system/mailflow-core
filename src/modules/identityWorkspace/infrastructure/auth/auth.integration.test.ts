import { randomUUID } from 'node:crypto'

import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../../../../app.js'
import { createDatabase } from '../../../../shared/database/client.js'
import type { AccountEmailMessage, AccountEmailSender } from '../../accountEmails/index.js'
import { loadAuthConfig } from './authConfig.js'
import { createAuth } from './createAuth.js'

const databaseUrl = process.env.MAILFLOW_AUTH_INTEGRATION_DATABASE_URL
const describeIntegration = databaseUrl === undefined ? describe.skip : describe

describeIntegration('Better Auth PostgreSQL lifecycle', () => {
  const email = `qa-auth-${randomUUID()}@mailflow.invalid`
  const concurrentRecoveryEmail = `qa-auth-recovery-${randomUUID()}@mailflow.invalid`
  const authConfig = loadAuthConfig({
    APP_ENV: 'development',
    BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
    BETTER_AUTH_URL: 'http://localhost:8080',
    SITE_URL: 'http://localhost:4321',
    WEB_APP_URL: 'http://localhost:3000',
    RESEND_API_KEY: 're_test_integration_placeholder',
    RESEND_FROM_EMAIL: 'noreply@mailflow-ai.online',
  })
  const logger = pino({ enabled: false })
  const sentEmails: AccountEmailMessage[] = []
  const sendAccountEmail: AccountEmailSender = async (message) => {
    sentEmails.push(message)
  }
  const database = createDatabase(
    databaseUrl ?? 'postgresql://invalid:invalid@localhost:5432/invalid',
    logger,
  )
  const auth = createAuth(database.database, authConfig, sendAccountEmail)
  const app = createApp({
    config: {
      appEnv: 'development',
      databaseUrl: databaseUrl ?? 'postgresql://invalid:invalid@localhost:5432/invalid',
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'silent',
      apiDocsEnabled: false,
      serviceVersion: 'test',
      otlpEndpoint: undefined,
      otelTraceSampleRate: 0.1,
      serviceInstanceId: 'auth-integration-test',
    },
    logger,
    checkDatabase: database.check,
    auth,
    allowedAuthOrigins: authConfig.allowedOrigins,
  })

  app.get('/api/v1/private', (context) => context.json({ protected: true }))

  beforeAll(async () => {
    await database.check()
  })

  afterAll(async () => {
    try {
      const relation = await database.pool.query<{ table: string | null }>(
        'select to_regclass(\'identity_workspace."user"\') as table',
      )

      if (relation.rows[0]?.table !== null) {
        for (const cleanupEmail of [email, concurrentRecoveryEmail]) {
          const user = await database.pool.query<{ id: string }>(
            'select id from identity_workspace."user" where email = $1',
            [cleanupEmail],
          )
          if (user.rows[0]) {
            await database.pool.query('delete from identity_workspace.rate_limit where key = $1', [
              `password-reset-account:${user.rows[0].id}`,
            ])
          }
          await database.pool.query('delete from identity_workspace."user" where email = $1', [
            cleanupEmail,
          ])
          await database.pool.query(
            'delete from identity_workspace.verification where identifier like $1',
            [`%${cleanupEmail}`],
          )
        }
      }
    } finally {
      await database.pool.end()
    }
  })

  it('requires OTP verification before sign-in and protects the verified user session', async () => {
    const signUp = await app.request('http://localhost:8080/api/auth/sign-up/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: authConfig.webAppURL,
      },
      body: JSON.stringify({
        name: 'MailFlow QA Auth',
        email,
        password: 'safe-test-password-123',
      }),
    })

    expect(signUp.status).toBe(200)
    expect(signUp.headers.get('access-control-allow-origin')).toBe(authConfig.webAppURL)
    expect(signUp.headers.get('set-cookie')).toBeNull()
    expect(await signUp.json()).toMatchObject({
      token: null,
      user: { email, emailVerified: false },
    })

    const verificationOtp = [...sentEmails]
      .reverse()
      .find((message) => message.kind === 'verification-otp')
    expect(verificationOtp?.kind).toBe('verification-otp')
    if (verificationOtp?.kind !== 'verification-otp') {
      throw new Error('Expected a verification OTP to be sent')
    }

    const blockedSignIn = await app.request('http://localhost:8080/api/auth/sign-in/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: authConfig.webAppURL,
      },
      body: JSON.stringify({ email, password: 'safe-test-password-123' }),
    })
    expect(blockedSignIn.ok).toBe(false)
    expect(blockedSignIn.headers.get('set-cookie')).toBeNull()

    const verifyEmail = await app.request('http://localhost:8080/api/auth/email-otp/verify-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: authConfig.webAppURL,
      },
      body: JSON.stringify({ email, otp: verificationOtp.otp }),
    })
    expect(verifyEmail.status).toBe(200)
    expect(verifyEmail.headers.get('set-cookie')).toBeNull()
    expect(await verifyEmail.json()).toMatchObject({
      status: true,
      token: null,
      user: { email, emailVerified: true },
    })
    expect(sentEmails.filter((message) => message.kind === 'verified-welcome')).toHaveLength(1)

    const signIn = await app.request('http://localhost:8080/api/auth/sign-in/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: authConfig.webAppURL,
      },
      body: JSON.stringify({ email, password: 'safe-test-password-123' }),
    })

    expect(signIn.status).toBe(200)
    const sessionCookie = signIn.headers.get('set-cookie')?.split(';')[0]
    expect(sessionCookie).toBeDefined()

    const session = await app.request('http://localhost:8080/api/auth/get-session', {
      headers: { Cookie: sessionCookie ?? '' },
    })
    const protectedResource = await app.request('http://localhost:8080/api/v1/private', {
      headers: { Cookie: sessionCookie ?? '' },
    })
    const storedSessions = await database.pool.query(
      'select count(*)::int as count from identity_workspace.session session join identity_workspace."user" "user" on "user".id = session.user_id where "user".email = $1',
      [email],
    )

    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ user: { email } })
    expect(protectedResource.status).toBe(200)
    expect(storedSessions.rows).toEqual([{ count: 1 }])

    const signOut = await app.request('http://localhost:8080/api/auth/sign-out', {
      method: 'POST',
      headers: { Cookie: sessionCookie ?? '' },
    })
    const revokedResource = await app.request('http://localhost:8080/api/v1/private', {
      headers: { Cookie: sessionCookie ?? '' },
    })
    const revokedSessions = await database.pool.query(
      'select count(*)::int as count from identity_workspace.session session join identity_workspace."user" "user" on "user".id = session.user_id where "user".email = $1',
      [email],
    )

    expect(signOut.status).toBe(200)
    expect(revokedResource.status).toBe(401)
    expect(revokedSessions.rows).toEqual([{ count: 0 }])
  })

  it('allows only one simultaneous recovery request for the same account', async () => {
    const request = (path: string, body: unknown, ip: string) =>
      app.request(`http://localhost:8080/api/auth${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: authConfig.webAppURL,
          'x-real-ip': ip,
        },
        body: JSON.stringify(body),
      })

    const signUp = await request(
      '/sign-up/email',
      {
        name: 'MailFlow QA Recovery',
        email: concurrentRecoveryEmail,
        password: 'safe-test-password-123',
      },
      '203.0.113.10',
    )
    expect(signUp.status).toBe(200)

    const verificationOtp = [...sentEmails]
      .reverse()
      .find(
        (message) => message.kind === 'verification-otp' && message.to === concurrentRecoveryEmail,
      )
    expect(verificationOtp?.kind).toBe('verification-otp')
    if (verificationOtp?.kind !== 'verification-otp') {
      throw new Error('Expected a verification OTP for the recovery account')
    }

    const verifyEmail = await request(
      '/email-otp/verify-email',
      { email: concurrentRecoveryEmail, otp: verificationOtp.otp },
      '203.0.113.10',
    )
    expect(verifyEmail.status).toBe(200)

    const resetEmailCount = sentEmails.filter(
      (message) => message.kind === 'password-reset' && message.to === concurrentRecoveryEmail,
    ).length
    const [first, second] = await Promise.all([
      request(
        '/request-password-reset',
        {
          email: concurrentRecoveryEmail,
          redirectTo: `${authConfig.webAppURL}/reset-password`,
        },
        '203.0.113.11',
      ),
      request(
        '/request-password-reset',
        {
          email: concurrentRecoveryEmail,
          redirectTo: `${authConfig.webAppURL}/reset-password`,
        },
        '203.0.113.12',
      ),
    ])
    const responses = [first, second]
    expect(responses.map((response) => response.status).sort()).toEqual([200, 429])

    const limitedResponse = responses.find((response) => response.status === 429)
    expect(limitedResponse?.headers.get('x-retry-after')).toMatch(/^\d+$/)
    expect(await limitedResponse?.json()).toMatchObject({ code: 'PASSWORD_RESET_RATE_LIMITED' })
    expect(
      sentEmails.filter(
        (message) => message.kind === 'password-reset' && message.to === concurrentRecoveryEmail,
      ),
    ).toHaveLength(resetEmailCount + 1)
  })
})
