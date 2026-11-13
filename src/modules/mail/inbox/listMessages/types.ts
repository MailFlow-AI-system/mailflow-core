import type { Pool, PoolClient } from 'pg'
import type { Label } from '../../labels/types.js'
import type {
  MailFolder,
  MessageAction,
  MessageActionResult,
  MessageLocation,
  MessagePatch,
} from '../messageActions/contract.js'

export type MailPool = Pick<Pool, 'connect'>
export type MailClient = PoolClient
export type ResolveWorkspace = (
  userId: string,
  slug: string,
) => Promise<{ id: string; capabilities: readonly string[] } | null>
export type MailEnvironment = { Variables: { workspaceId: string } }

export type MailMessage = {
  id: string
  senderName: string
  labels?: Label[]
  subject: string
  body: string
  receivedAt: Date
}

/**
 * Read and star belong to the current user; folder timestamps and actor ids are shared by the
 * workspace. `folder` applies the trash > spam > archive precedence.
 */
export type MessageState = {
  isRead: boolean
  isStarred: boolean
  folder: MessageLocation
  archivedAt: string | null
  archivedBy: string | null
  trashedAt: string | null
  trashedBy: string | null
  spamAt: string | null
  spamBy: string | null
}

export type InboxMessage = MailMessage & MessageState
export type MessageStateView = { id: string } & MessageState
export type UnreadCounts = Record<MailFolder, number>

export type MessageCursor = Pick<MailMessage, 'id' | 'receivedAt'>

export type MessageDetail = {
  id: string
  labels?: Label[]
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
} & MessageState

export type MessageScope = { workspaceId: string; userId: string }

export type MailMessageRepository = {
  /** Reads a message and marks it read for the user, keeping the first read time. */
  findMessage?: (workspaceId: string, id: string, userId: string) => Promise<MessageDetail | null>
  findMessages: (
    input: MessageScope & {
      folder: MailFolder
      search: string
      cursor: MessageCursor | null
    },
  ) => Promise<InboxMessage[]>
  countUnread: (workspaceId: string, userId: string) => Promise<UnreadCounts>
  /** Applies an idempotent partial change; null when the message is unavailable. */
  updateMessage: (
    workspaceId: string,
    userId: string,
    id: string,
    patch: MessagePatch,
  ) => Promise<MessageStateView | null>
  /** Applies one action to distinct ids in a single transaction, reporting each id. */
  applyAction: (
    workspaceId: string,
    userId: string,
    ids: string[],
    action: MessageAction,
  ) => Promise<MessageActionResult[]>
}

export type ListMessagesQuery = {
  q?: string | undefined
  cursor?: string | undefined
  folder?: MailFolder | undefined
}

export type ListMessagesResponse = {
  items: (Omit<InboxMessage, 'receivedAt'> & { receivedAt: string })[]
  nextCursor: string | null
}
