import { z } from 'zod'

import { type MailListSort, mailListOrder } from '../../shared/listSort.js'
import type {
  InboxMessage,
  ListMessagesQuery,
  ListMessagesResponse,
  MailMessageRepository,
  MessageCursor,
  MessageScope,
} from './types.js'

export const INBOX_PAGE_SIZE = 8
/**
 * Text sorts order by the first 256 characters of the lowercase sender or subject, which keeps
 * the cursor key, and therefore the cursor itself, bounded for arbitrarily long subjects.
 */
export const MESSAGE_SORT_KEY_LENGTH = 256
// A full-length key of escaped characters fits with room to spare.
const MAX_CURSOR_LENGTH = 4096

const id = z.uuid()
const receivedAt = z.iso.datetime({ precision: 3 })
const cursorSchema = z.union([
  // Cursors issued before sorting existed carry no sort and resume the newest order.
  z.strictObject({ receivedAt, id }),
  z.strictObject({ sort: z.enum(['newest', 'oldest']), receivedAt, id }),
  z.strictObject({
    sort: z.enum(['sender-asc', 'sender-desc', 'subject-asc', 'subject-desc']),
    // Stored text never contains NUL, which PostgreSQL rejects as a query parameter.
    key: z
      .string()
      .refine((key) => [...key].length <= MESSAGE_SORT_KEY_LENGTH && !key.includes('\u0000')),
    id,
  }),
])

export class InvalidMessageCursorError extends Error {}

function decodeCursor(value: string, sort: MailListSort): MessageCursor {
  try {
    if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new InvalidMessageCursorError()
    }

    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) {
      throw new InvalidMessageCursorError()
    }

    const parsed = cursorSchema.parse(JSON.parse(decoded.toString('utf8')))
    if (('sort' in parsed ? parsed.sort : 'newest') !== sort) {
      throw new InvalidMessageCursorError()
    }
    if ('key' in parsed) return { id: parsed.id, key: parsed.key }

    const date = new Date(parsed.receivedAt)
    if (date.toISOString() !== parsed.receivedAt) {
      throw new InvalidMessageCursorError()
    }

    return { id: parsed.id, receivedAt: date }
  } catch {
    throw new InvalidMessageCursorError('The message cursor is invalid.')
  }
}

function encodeCursor(sort: MailListSort, message: InboxMessage) {
  const { field } = mailListOrder(sort)
  const payload =
    field === 'date'
      ? { sort, receivedAt: message.receivedAt.toISOString(), id: message.id }
      : {
          sort,
          // Code points match PostgreSQL left(); the repository applies the same bound again.
          key: [...(field === 'sender' ? message.senderName : message.subject)]
            .slice(0, MESSAGE_SORT_KEY_LENGTH)
            .join(''),
          id: message.id,
        }
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

export async function listMessages(
  repository: Pick<MailMessageRepository, 'findMessages'>,
  scope: MessageScope,
  query: ListMessagesQuery,
): Promise<ListMessagesResponse> {
  const sort = query.sort ?? 'newest'
  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor, sort)
  const messages = await repository.findMessages({
    ...scope,
    folder: query.folder ?? 'inbox',
    search: query.q?.trim() ?? '',
    sort,
    cursor,
  })
  const page = messages.slice(0, INBOX_PAGE_SIZE)
  const lastMessage = page.at(-1)

  return {
    items: page.map((message) => ({ ...message, receivedAt: message.receivedAt.toISOString() })),
    nextCursor:
      messages.length > INBOX_PAGE_SIZE && lastMessage ? encodeCursor(sort, lastMessage) : null,
  }
}
