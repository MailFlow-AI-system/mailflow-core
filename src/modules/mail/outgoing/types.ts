import type { MailContext } from '../context/types.js'
import type { SendEmailInput } from './contract.js'

export class MessageConflictError extends Error {}

export type ProviderAttachment = {
  filename: string
  content: string
  contentType?: string
  contentId?: string
}
export type ProviderEmailInput = Omit<SendEmailInput, 'attachments'> & {
  attachments: ProviderAttachment[]
}
export type SentAttachment = {
  id: string
  filename: string
  contentType: string
  size: number
  sha256: string
  contentId: string | null
}

export type ReservedEmail = {
  id: string
  payloadHash: string
  providerId: string | null
  createdAt: Date
  deliveryKey: string | null
}
export type SentEmail = {
  id: string
  to: string[]
  cc: string[]
  bcc: string[]
  recipientName: string
  subject: string
  text: string
  sentAt: Date | null
  attachments?: SentAttachment[]
}
export type OutgoingRepository = {
  reserve: (
    input: SendEmailInput & MailContext & { payloadHash: string; deliveryKey: string },
  ) => Promise<ReservedEmail>
  markSent: (context: MailContext, id: string, providerId: string) => Promise<void>
  listSent: (userId: string, offset: number) => Promise<SentEmail[]>
  findSent?: (context: MailContext, id: string) => Promise<(SentEmail & { html: string }) | null>
}
export type OutgoingMail = {
  repository: OutgoingRepository
  deliver: (input: ProviderEmailInput, idempotencyKey: string) => Promise<string>
  resolveAttachments?: (
    context: MailContext,
    references: SendEmailInput['attachments'],
  ) => Promise<ProviderAttachment[]>
}
