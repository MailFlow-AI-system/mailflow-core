import { createHmac } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import { z } from 'zod'
import type { AccountEmailSender } from '../accountEmails/index.js'
import type { AuthConfig } from '../infrastructure/auth/authConfig.js'
import { createAuth } from '../infrastructure/auth/createAuth.js'
import { createOnboardingEnqueue } from './enqueueEmail.js'
import { createOnboardingBudget } from './requestBudget.js'
import { inOnboardingTransaction } from './transaction.js'
import type { IdentityRow, OnboardingEnqueueFactory } from './types.js'
import { createOnboardingCipher } from './utils/cipher.js'
import { createProtectedOtpStorage } from './utils/otpStorage.js'
import { initialWorkspaceLogin } from './workspaceLogin.js'

const verifiedResponse = z.object({
  status: z.literal(true),
  token: z.null(),
  user: z.object({ id: z.string().min(1), emailVerified: z.literal(true) }),
})

export function createOnboardingOtpHandler(
  pool: Pool,
  config: AuthConfig,
  webBaseOrigin: string,
  enqueueFactory: OnboardingEnqueueFactory = createOnboardingEnqueue,
) {
  const cipher = createOnboardingCipher(config.secret)
  const sendBudget = createOnboardingBudget(pool, config.secret, 'otp-send')
  const verifyBudget = createOnboardingBudget(pool, config.secret, 'otp-verify')
  return async (request: Request) => {
    const body = await request
      .clone()
      .json()
      .catch(() => null)
    const email = z
      .object({ email: z.string().trim().max(254).toLowerCase().pipe(z.email()) })
      .safeParse(body)
    if (email.success) {
      const path = new URL(request.url).pathname.replace(/\/$/, '')
      const budget =
        path.endsWith('/verify-email') || path.endsWith('/check-verification-otp')
          ? verifyBudget
          : sendBudget
      const retryAfter = await budget(email.data.email)
      if (retryAfter)
        return Response.json(
          { code: 'OTP_RATE_LIMITED', message: 'Please wait before retrying verification.' },
          {
            status: 429,
            headers: { 'Retry-After': String(retryAfter), 'Cache-Control': 'private, no-store' },
          },
        )
    }
    return inOnboardingTransaction(pool, async (client) => {
      if (email.success) {
        const lockKey = `onboarding-otp:${createHmac('sha256', config.secret).update(email.data.email).digest('hex')}`
        // Better Auth reads then updates OTP attempts. Serialize all consumers,
        // including check/resend, to avoid lost attempts or duplicate verification.
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey])
      }
      let deliveryFailed = false
      const enqueue: AccountEmailSender = async (message) => {
        try {
          if (message.kind === 'password-reset') throw new Error('Unsupported onboarding delivery')
          const users = await client.query<IdentityRow>(
            'select id from identity_workspace."user" where email = $1',
            [message.to],
          )
          const userId = users.rows[0]?.id
          if (!userId || (message.kind === 'verified-welcome' && message.userId !== userId))
            throw new Error('Invalid delivery identity')
          await client.query("select set_config('mailflow.user_id', $1, true)", [userId])
          const payload =
            message.kind === 'verified-welcome'
              ? { ...message, loginUrl: await initialWorkspaceLogin(client, userId, webBaseOrigin) }
              : message
          await enqueueFactory(client, userId, cipher)(payload)
        } catch {
          deliveryFailed = true
          throw new Error('Onboarding email enqueue failed')
        }
      }
      const auth = createAuth(
        drizzle(client),
        config,
        enqueue,
        () => {
          deliveryFailed = true
        },
        {
          otpStorage: createProtectedOtpStorage(cipher),
        },
      )
      const response = await auth.handler(request)
      if (deliveryFailed) throw new Error('Onboarding email enqueue failed')
      // Commit ordinary validation errors: rolling back an invalid OTP would also
      // roll back Better Auth's attempt counter and make brute force unlimited.
      if (
        !response.ok ||
        !new URL(request.url).pathname.replace(/\/$/, '').endsWith('/email-otp/verify-email')
      )
        return response
      const body = await response.clone().json()
      const result = verifiedResponse.safeParse(body)
      if (!result.success) throw new Error('Unexpected verification result')
      const loginUrl = await initialWorkspaceLogin(client, result.data.user.id, webBaseOrigin)
      return Response.json(
        { ...body, loginUrl },
        { status: response.status, headers: response.headers },
      )
    })
  }
}
