import type { BetterAuthOptions } from 'better-auth'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

export type AuthDatabase = NodePgDatabase
export type AuthProvisioningOptions = {
  localWorkspaceCookie?: boolean
  generateId?: NonNullable<NonNullable<BetterAuthOptions['advanced']>['database']>['generateId']
  otpStorage?: {
    encrypt: (value: string) => Promise<string>
    decrypt: (value: string) => Promise<string>
  }
}
export type AuthEmailFailureReporter = (operation: 'account-welcome' | 'password-reset') => void
export type PasswordResetDeliveryInput = {
  user: { email: string; name: string }
  url: string
  token: string
}
export type VerificationStatusUser = { emailVerified: boolean }
export type VerifiedAccountUser = { id: string; email: string; name: string }
export type PasswordResetRateLimit = { lastRequest: number | bigint }
