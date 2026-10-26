import type { SendEmailInput } from './contract.js'

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
}
export type OutgoingRepository = {
  reserve: (
    input: SendEmailInput & { userId: string; payloadHash: string },
  ) => Promise<ReservedEmail>
  markSent: (userId: string, id: string, providerId: string) => Promise<void>
  listSent: (userId: string, offset: number) => Promise<SentEmail[]>
}
export type OutgoingMail = {
  repository: OutgoingRepository
  deliver: (input: SendEmailInput, idempotencyKey: string) => Promise<string>
}
