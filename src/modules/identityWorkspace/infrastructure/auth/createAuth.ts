import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { emailOTP } from 'better-auth/plugins'
import type { createDatabase } from '#shared/database/client'
import { type AccountEmailSender, createAccountEmailSender } from '../../accountEmails/index.js'
import { authAccount } from '../database/schema/auth/account.js'
import { authRateLimit } from '../database/schema/auth/rateLimit.js'
import { authSession } from '../database/schema/auth/session.js'
import { authUser } from '../database/schema/auth/user.js'
import { authVerification } from '../database/schema/auth/verification.js'
import type { AuthConfig } from './authConfig.js'

type Database = ReturnType<typeof createDatabase>['database']

const authSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
  rateLimit: authRateLimit,
}

const passwordAlreadyInUseError = {
  code: 'PASSWORD_ALREADY_IN_USE',
  message: 'Choose a new password that differs from your current password.',
}

export function createAuth(
  database: Database,
  config: AuthConfig,
  sendAccountEmail: AccountEmailSender = createAccountEmailSender(config),
  reportEmailDeliveryFailure: AuthEmailFailureReporter = () => {},
) {
  return betterAuth({
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema: authSchema,
      schemaName: 'identity_workspace',
    }),
    ...createAuthOptions(config, sendAccountEmail, reportEmailDeliveryFailure),
  })
}

type AuthEmailFailureReporter = (operation: 'account-welcome' | 'password-reset') => void

export function createAuthOptions(
  config: AuthConfig,
  sendAccountEmail: AccountEmailSender,
  reportEmailDeliveryFailure: AuthEmailFailureReporter = () => {},
) {
  const failedPasswordResetRequests = new WeakMap<Request, string>()

  return {
    disabledPaths: [
      '/sign-in/email-otp',
      '/email-otp/request-password-reset',
      '/email-otp/reset-password',
      '/forget-password/email-otp',
    ],
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: config.allowedOrigins,
    rateLimit: {
      enabled: true,
      storage: 'database' as const,
      customRules: {
        '/request-password-reset': { window: 60, max: 3 },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async (
        {
          user,
          url,
          token,
        }: {
          user: { email: string; name: string }
          url: string
          token: string
        },
        request?: Request,
      ) => {
        try {
          await sendAccountEmail({
            kind: 'password-reset',
            to: user.email,
            name: user.name,
            url,
          })
        } catch {
          if (request) failedPasswordResetRequests.set(request, `reset-password:${token}`)
          reportEmailDeliveryFailure('password-reset')
        }
      },
    },
    emailVerification: {
      autoSignInAfterVerification: false,
      beforeEmailVerification: async (user: { emailVerified: boolean }) => {
        if (user.emailVerified) {
          throw APIError.from('BAD_REQUEST', {
            code: 'EMAIL_ALREADY_VERIFIED',
            message: 'Email is already verified',
          })
        }
      },
      afterEmailVerification: async (user: { id: string; email: string; name: string }) => {
        const welcomeMessage = {
          kind: 'verified-welcome' as const,
          to: user.email,
          name: user.name,
          userId: user.id,
          loginUrl: `${config.webAppURL}/login`,
        }

        try {
          await sendAccountEmail(welcomeMessage)
        } catch {
          try {
            // Reuse the user-scoped idempotency key for one same-payload retry.
            await sendAccountEmail(welcomeMessage)
          } catch {
            reportEmailDeliveryFailure('account-welcome')
          }
        }
      },
    },
    plugins: [
      emailOTP({
        allowedAttempts: 3,
        disableSignUp: true,
        expiresIn: 5 * 60,
        otpLength: 6,
        overrideDefaultEmailVerification: true,
        resendStrategy: 'rotate',
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== 'email-verification') return
          await sendAccountEmail({ kind: 'verification-otp', to: email, otp })
        },
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path === '/request-password-reset') {
          const email = context.body?.email
          if (typeof email !== 'string') return

          const user = await context.context.internalAdapter.findUserByEmail(email)
          if (!user) {
            throw APIError.from('NOT_FOUND', {
              code: 'ACCOUNT_NOT_FOUND',
              message: 'No account is registered with this email address.',
            })
          }

          const adapter = context.context.adapter
          const key = `password-reset-account:${user.user.id}`
          const windowSeconds = 60
          for (;;) {
            const readRateLimit = async () =>
              (
                await adapter.findMany({
                  model: 'rateLimit',
                  where: [{ field: 'key', value: key }],
                })
              )[0]
            const rateLimit = (await readRateLimit()) as
              | { lastRequest: number | bigint }
              | undefined
            const now = Date.now()

            if (!rateLimit) {
              try {
                await adapter.create({
                  model: 'rateLimit',
                  data: { key, count: 1, lastRequest: now },
                })
                break
              } catch (error) {
                if (!(await readRateLimit())) throw error
                continue
              }
            }

            const lastRequest = Number(rateLimit.lastRequest)
            if (now - lastRequest >= windowSeconds * 1000) {
              const updated = await adapter.incrementOne({
                model: 'rateLimit',
                where: [
                  { field: 'key', value: key },
                  { field: 'lastRequest', operator: 'lte', value: lastRequest },
                ],
                increment: {},
                set: { count: 1, lastRequest: now },
              })
              if (updated) break
              continue
            }

            const retryAfter = Math.ceil((lastRequest + windowSeconds * 1000 - now) / 1000)
            throw new APIError(
              'TOO_MANY_REQUESTS',
              {
                code: 'PASSWORD_RESET_RATE_LIMITED',
                message: 'Please wait before requesting another recovery link.',
              },
              { 'X-Retry-After': String(retryAfter) },
            )
          }
          return
        }

        if (context.path !== '/reset-password') return

        const token = context.body?.token || context.query?.token
        const newPassword = context.body?.newPassword
        if (typeof token !== 'string' || typeof newPassword !== 'string') return

        const verification = await context.context.internalAdapter.findVerificationValue(
          `reset-password:${token}`,
        )
        if (!verification || verification.expiresAt < new Date()) return

        const credentialAccount = await context.context.internalAdapter.findCredentialAccount(
          verification.value,
        )
        if (
          typeof credentialAccount?.password !== 'string' ||
          !(await context.context.password.verify({
            password: newPassword,
            hash: credentialAccount.password,
          }))
        ) {
          return
        }

        throw APIError.from('BAD_REQUEST', passwordAlreadyInUseError)
      }),
      after: createAuthMiddleware(async (context) => {
        if (context.path !== '/request-password-reset' || !context.request) return

        const verificationIdentifier = failedPasswordResetRequests.get(context.request)
        if (!verificationIdentifier) return

        failedPasswordResetRequests.delete(context.request)
        try {
          await context.context.internalAdapter.deleteVerificationByIdentifier(
            verificationIdentifier,
          )
        } catch {
          reportEmailDeliveryFailure('password-reset')
        }

        throw APIError.from('SERVICE_UNAVAILABLE', {
          code: 'PASSWORD_RESET_EMAIL_DELIVERY_FAILED',
          message: 'Password recovery email could not be sent. Please try again shortly.',
        })
      }),
    },
  }
}
