import type { Pool, PoolClient } from 'pg'
import type { z } from 'zod'
import type {
  AccountEmailDeliveryOptions,
  AccountEmailMessage,
  AccountEmailSender,
} from '../accountEmails/index.js'
import type { AuthConfig } from '../infrastructure/auth/authConfig.js'
import type { signupSchema } from './schemas.js'

export type SignupInput = z.infer<typeof signupSchema>
export type SignupResult = { status: 'verification-pending' }
export type OnboardingCipher = {
  seal: (value: string, scope: string) => string
  open: (value: string, scope: string) => string
}
export type SignupIds = { userId: string; workspaceId: string }
export type SignupActions = {
  register: (input: SignupInput) => Promise<void>
  provision: (input: SignupInput) => Promise<void>
}
export type SignupActionsFactory = (
  client: PoolClient,
  config: AuthConfig,
  enqueue: AccountEmailSender,
  ids: SignupIds,
  cipher: OnboardingCipher,
) => SignupActions
export type OnboardingEnqueueFactory = (
  client: PoolClient,
  userId: string,
  cipher: OnboardingCipher,
) => AccountEmailSender
export type SignupReceipt = { fingerprint: string; user_id: string; organization_id: string }
export type OnboardingService = {
  signup: (input: SignupInput, key: string) => Promise<SignupResult>
}
export type OnboardingEmailMessage = Exclude<AccountEmailMessage, { kind: 'password-reset' }>
export type IdentityRow = { id: string }
export type WorkspaceSlugRow = { slug: string }
export type RoleSafetyRow = { unsafe: boolean }
export type EmailJob = {
  id: string
  user_id: string
  kind: OnboardingEmailMessage['kind']
  payload: string
  attempts: number
  lease_token: string
}
export type QueuedEmailSender = (
  message: OnboardingEmailMessage,
  options: AccountEmailDeliveryOptions,
) => Promise<void>
export type DeliveryDependencies = { pool: Pool; cipher: OnboardingCipher; send: QueuedEmailSender }
export type OnboardingRouteDependencies = {
  service: OnboardingService
  handleOtp: (request: Request) => Promise<Response>
  allowedOrigin: string
  consumeBudget: (email: string) => Promise<number>
  closeLegacySignup?: boolean
}
export type OnboardingBudgetRow = { count: number; last_request: number | string }
export type OnboardingBudgetKind = 'signup' | 'otp-send' | 'otp-verify'
export type DeliveryOutcome = 'idle' | 'sent' | 'retry' | 'expired' | 'lost'
export type OnboardingWorkerDependencies = {
  dispatch: () => Promise<DeliveryOutcome>
  signal: AbortSignal
  report: (outcome: DeliveryOutcome | 'failed') => void
}
