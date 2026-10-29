import type { Pool, PoolClient } from 'pg'

export type MailPool = Pick<Pool, 'connect'>
export type MailClient = PoolClient
export type ResolveWorkspace = (userId: string, slug: string) => Promise<{ id: string } | null>
export type MailEnvironment = { Variables: { workspaceId: string } }

export type MailMessage = {
  id: string
  senderName: string
  subject: string
  body: string
  receivedAt: Date
}

export type MessageCursor = Pick<MailMessage, 'id' | 'receivedAt'>

export type MessageDetail = {
  id: string
  subject: string
  senderName: string | null
  senderEmail: string | null
  to: string[]
  cc: string[]
  bcc: string[]
  html: string | null
  text: string
  date: string
  attachments: {
    id: string
    filename: string
    contentType: string
    size: number
    contentId: string | null
  }[]
}

export type MailMessageRepository = {
  findMessage?: (workspaceId: string, id: string, userId: string) => Promise<MessageDetail | null>
  findMessages: (input: {
    workspaceId: string
    search: string
    cursor: MessageCursor | null
  }) => Promise<MailMessage[]>
}

export type ListMessagesQuery = {
  q?: string | undefined
  cursor?: string | undefined
}

export type ListMessagesResponse = {
  items: (Omit<MailMessage, 'receivedAt'> & { receivedAt: string })[]
  nextCursor: string | null
}
