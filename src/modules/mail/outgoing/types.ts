import type { SendEmailInput } from './contract.js'

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
    input: SendEmailInput & { userId: string; payloadHash: string },
  ) => Promise<ReservedEmail>
  markSent: (userId: string, id: string, providerId: string) => Promise<void>
  listSent: (userId: string, offset: number) => Promise<SentEmail[]>
  findSent?: (userId: string, id: string) => Promise<(SentEmail & { html: string }) | null>
}
export type OutgoingMail = {
  repository: OutgoingRepository
  deliver: (input: ProviderEmailInput, idempotencyKey: string) => Promise<string>
  resolveAttachments?: (
    userId: string,
    references: SendEmailInput['attachments'],
  ) => Promise<ProviderAttachment[]>
}
