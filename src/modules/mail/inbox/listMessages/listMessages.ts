import { z } from 'zod'

import type {
  ListMessagesQuery,
  ListMessagesResponse,
  MailMessageRepository,
  MessageCursor,
} from './types.js'

export const INBOX_PAGE_SIZE = 8

const cursorSchema = z.strictObject({
  receivedAt: z.iso.datetime({ precision: 3 }),
  id: z.uuid(),
})

export class InvalidMessageCursorError extends Error {}

function decodeCursor(value: string): MessageCursor {
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new InvalidMessageCursorError()
    }

    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) {
      throw new InvalidMessageCursorError()
    }

    const parsed = cursorSchema.parse(JSON.parse(decoded.toString('utf8')))
    const receivedAt = new Date(parsed.receivedAt)
    if (receivedAt.toISOString() !== parsed.receivedAt) {
      throw new InvalidMessageCursorError()
    }

    return { id: parsed.id, receivedAt }
  } catch {
    throw new InvalidMessageCursorError('The message cursor is invalid.')
  }
}

export async function listMessages(
  repository: MailMessageRepository,
  query: ListMessagesQuery,
): Promise<ListMessagesResponse> {
  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor)
  const messages = await repository.findMessages({ search: query.q?.trim() ?? '', cursor })
  const items = messages.slice(0, INBOX_PAGE_SIZE).map((message) => ({
    ...message,
    receivedAt: message.receivedAt.toISOString(),
  }))
  const lastItem = items.at(-1)

  return {
    items,
    nextCursor:
      messages.length > INBOX_PAGE_SIZE && lastItem
        ? Buffer.from(
            JSON.stringify({ receivedAt: lastItem.receivedAt, id: lastItem.id }),
          ).toString('base64url')
        : null,
  }
}
