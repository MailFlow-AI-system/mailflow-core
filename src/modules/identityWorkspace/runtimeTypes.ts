import type { Pool } from 'pg'
import type { AccountEmailSender } from './accountEmails/index.js'
import type { AuthConfig } from './infrastructure/auth/authConfig.js'
import type { AuthService } from './infrastructure/types/auth.js'
import type { AuthOriginPolicy } from './infrastructure/types/authConfig.js'
import type { AuthDatabase, AuthEmailFailureReporter } from './infrastructure/types/authOptions.js'
import type {
  OnboardingRouteDependencies,
  OnboardingWorkerDependencies,
} from './onboarding/types.js'
import type { WorkspaceEntryDependencies } from './workspaces/entryTypes.js'
import type { MailWorkspaceAuthority } from './workspaces/mailWorkspaceAuthority.js'
import type {
  WorkspaceRouteDependencies,
  WorkspaceSelectionDependencies,
} from './workspaces/types.js'

export type IdentityWorkspaceRuntimeDependencies = {
  environment: NodeJS.ProcessEnv
  pool: Pool
  database: AuthDatabase
  authConfig?: AuthConfig
  sendAccountEmail?: AccountEmailSender
  reportEmailDeliveryFailure?: AuthEmailFailureReporter
}

export type IdentityWorkspaceRuntime = {
  auth: AuthService
  mailWorkspaceAuthority?: MailWorkspaceAuthority
  mailWorkspaceBaseOrigin?: string
  allowedAuthOrigins: string[]
  isAllowedAuthOrigin?: AuthOriginPolicy
  workspaces?: WorkspaceRouteDependencies
  workspaceSelection?: WorkspaceSelectionDependencies
  workspaceEntry?: WorkspaceEntryDependencies
  onboarding?: OnboardingRouteDependencies
}

export type IdentityWorkspaceWorkerDependencies = {
  environment: NodeJS.ProcessEnv
  pool: Pool
  signal: AbortSignal
  report: OnboardingWorkerDependencies['report']
}
