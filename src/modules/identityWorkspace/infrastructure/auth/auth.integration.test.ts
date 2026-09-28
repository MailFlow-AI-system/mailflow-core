import { randomUUID } from 'node:crypto'

import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../../../../app.js'
import { createDatabase } from '../../../../shared/database/client.js'
import { loadAuthConfig } from './authConfig.js'
import { createAuth } from './createAuth.js'

const databaseUrl = process.env.MAILFLOW_AUTH_INTEGRATION_DATABASE_URL
const describeIntegration = databaseUrl === undefined ? describe.skip : describe

describeIntegration('Better Auth PostgreSQL lifecycle', () => {
  const email = `qa-auth-${randomUUID()}@mailflow.invalid`
  const authConfig = loadAuthConfig({
    APP_ENV: 'development',
    BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
    BETTER_AUTH_URL: 'http://localhost:8080',
    SITE_URL: 'http://localhost:4321',
    WEB_APP_URL: 'http://localhost:3000',
  })
  const logger = pino({ enabled: false })
  const database = createDatabase(
    databaseUrl ?? 'postgresql://invalid:invalid@localhost:5432/invalid',
    logger,
  )
  const auth = createAuth(database.database, authConfig)
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
        await database.pool.query('delete from identity_workspace."user" where email = $1', [email])
      }
    } finally {
      await database.pool.end()
    }
  })

  it('registers, signs in, persists, reads, revokes, and protects a user session', async () => {
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

    const signUpCookie = signUp.headers.get('set-cookie')?.split(';')[0]
    expect(signUpCookie).toBeDefined()

    await app.request('http://localhost:8080/api/auth/sign-out', {
      method: 'POST',
      headers: { Cookie: signUpCookie ?? '' },
    })

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
})
