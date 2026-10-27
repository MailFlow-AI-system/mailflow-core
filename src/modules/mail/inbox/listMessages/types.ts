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

export type MailMessageRepository = {
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
