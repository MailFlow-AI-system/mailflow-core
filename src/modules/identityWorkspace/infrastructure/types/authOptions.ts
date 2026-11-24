import type { BetterAuthOptions } from 'better-auth'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

export type AuthDatabase = NodePgDatabase
// Resolves the slug of a workspace the user belongs to, preferring `hostSlug` when the user is
// a member there. Returns null when the user has no workspace.
export type AccountWorkspaceResolver = (userId: string, hostSlug?: string) => Promise<string | null>
export type WorkspaceHandoffGrant = { userId: string; workspaceId: string }
export type WorkspaceHandoffStore = {
  // Returns the destination slug when the user may enter the workspace, otherwise null.
  issue: (userId: string, workspaceId: string, codeHash: string) => Promise<string | null>
  // Atomically consumes the code; null when unknown, used, expired, revoked or on another host.
  consume: (codeHash: string, hostSlug: string) => Promise<WorkspaceHandoffGrant | null>
}
export type AuthProvisioningOptions = {
  workspaceHandoff?: WorkspaceHandoffStore
  accountWorkspace?: AccountWorkspaceResolver
  generateId?: NonNullable<NonNullable<BetterAuthOptions['advanced']>['database']>['generateId']
  otpStorage?: {
    encrypt: (value: string) => Promise<string>
    decrypt: (value: string) => Promise<string>
  }
}
export type AuthEmailFailureReporter = (operation: 'account-welcome' | 'password-reset') => void
export type PasswordResetDeliveryInput = {
  user: { id: string; email: string; name: string }
  url: string
  token: string
}
export type VerificationStatusUser = { emailVerified: boolean }
export type VerifiedAccountUser = { id: string; email: string; name: string }
export type PasswordResetRateLimit = { lastRequest: number | bigint }
