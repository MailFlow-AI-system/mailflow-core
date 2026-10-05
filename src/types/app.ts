import type { Logger } from 'pino'
import type {
  AuthService,
  OnboardingRouteDependencies,
  WorkspaceEntryDependencies,
  WorkspaceRouteDependencies,
  WorkspaceSelectionDependencies,
} from '#modules/identityWorkspace'
import type { MailMessageRepository } from '#modules/mail'
import type { AppConfig } from '#shared/config/env'
import type { Observability } from '#shared/observability/observability'

export type AppDependencies = {
  config: AppConfig
  logger: Logger
  checkDatabase: () => Promise<void>
  auth: AuthService
  allowedAuthOrigins: string[]
  mailRepository?: MailMessageRepository
  observability?: Observability
  workspaces?: WorkspaceRouteDependencies
  onboarding?: OnboardingRouteDependencies
  workspaceSelection?: WorkspaceSelectionDependencies
  workspaceEntry?: WorkspaceEntryDependencies
}
