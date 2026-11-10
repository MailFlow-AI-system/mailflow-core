import type { Logger } from 'pino'
import type { IdentityWorkspaceRuntime } from '#modules/identityWorkspace'
import type {
  AttachmentService,
  DraftRepository,
  LabelRepository,
  MailMessageRepository,
  OutgoingMail,
} from '#modules/mail'
import type { AppConfig } from '#shared/config/env'
import type { Observability } from '#shared/observability/observability'

export type AppDependencies = IdentityWorkspaceRuntime & {
  config: AppConfig
  logger: Logger
  checkDatabase: () => Promise<void>
  labels?: LabelRepository
  drafts?: DraftRepository
  mailRepository?: MailMessageRepository
  outgoingMail?: OutgoingMail
  attachments?: AttachmentService
  observability?: Observability
}
