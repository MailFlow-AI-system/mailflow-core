export type MailMessage = {
  id: string
  senderName: string
  subject: string
  body: string
  receivedAt: Date
}

export type MessageCursor = Pick<MailMessage, 'id' | 'receivedAt'>

export type MailMessageRepository = {
  findMessages: (input: { search: string; cursor: MessageCursor | null }) => Promise<MailMessage[]>
}

export type ListMessagesQuery = {
  q?: string | undefined
  cursor?: string | undefined
}

export type ListMessagesResponse = {
  items: (Omit<MailMessage, 'receivedAt'> & { receivedAt: string })[]
  nextCursor: string | null
}
