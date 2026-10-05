import type { createDatabase } from '#shared/database/client'

export type AuthDatabase = ReturnType<typeof createDatabase>['database']
export type AuthEmailFailureReporter = (operation: 'account-welcome' | 'password-reset') => void
export type PasswordResetDeliveryInput = {
  user: { email: string; name: string }
  url: string
  token: string
}
export type VerificationStatusUser = { emailVerified: boolean }
export type VerifiedAccountUser = { id: string; email: string; name: string }
export type PasswordResetRateLimit = { lastRequest: number | bigint }
