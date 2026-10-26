import type { Logger } from 'pino'
import type { IdentityWorkspaceRuntime } from '#modules/identityWorkspace'
import type { MailMessageRepository, OutgoingMail } from '#modules/mail'
import type { AppConfig } from '#shared/config/env'
import type { Observability } from '#shared/observability/observability'

export type AppDependencies = IdentityWorkspaceRuntime & {
  config: AppConfig
  logger: Logger
  checkDatabase: () => Promise<void>
  mailRepository?: MailMessageRepository
  outgoingMail?: OutgoingMail
  observability?: Observability
}
