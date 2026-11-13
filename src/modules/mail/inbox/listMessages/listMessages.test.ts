import { describe, expect, it, vi } from 'vitest'

import { InvalidMessageCursorError, listMessages } from './listMessages.js'
import type { InboxMessage, MailMessageRepository } from './types.js'

const message = (index: number): InboxMessage => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  senderName: `Sender ${index}`,
  subject: `Subject ${index}`,
  body: `Full message body ${index}`,
  receivedAt: new Date('2026-10-01T12:00:00.000Z'),
  isRead: index % 2 === 0,
  isStarred: false,
  folder: 'inbox',
  archivedAt: null,
  archivedBy: null,
  trashedAt: null,
  trashedBy: null,
  spamAt: null,
  spamBy: null,
})

function repository(items: InboxMessage[] = []) {
  return { findMessages: vi.fn().mockResolvedValue(items) } satisfies Pick<
    MailMessageRepository,
    'findMessages'
  >
}

const scope = { workspaceId: 'workspace-a', userId: 'user-a' }
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

describe('list inbox messages', () => {
  it('returns an empty page and no cursor', async () => {
    const source = repository()

    expect(await listMessages(source, scope, {})).toEqual({ items: [], nextCursor: null })
    expect(source.findMessages).toHaveBeenCalledWith({
      ...scope,
      folder: 'inbox',
      search: '',
      cursor: null,
    })
  })

  it.each(['inbox', 'starred', 'archive', 'trash', 'spam'] as const)(
    'delegates the %s folder for the current user',
    async (folder) => {
      const source = repository()
      await listMessages(source, scope, { folder })
      expect(source.findMessages).toHaveBeenCalledWith({
        ...scope,
        folder,
        search: '',
        cursor: null,
      })
    },
  )

  it('returns full message bodies, state and ISO dates on the last partial page', async () => {
    const source = repository([message(1), message(2)])

    expect(await listMessages(source, scope, {})).toEqual({
      items: [message(1), message(2)].map((item) => ({
        ...item,
        receivedAt: item.receivedAt.toISOString(),
      })),
      nextCursor: null,
    })
  })

  it('does not create a cursor for exactly eight remaining messages', async () => {
    const page = await listMessages(
      repository(Array.from({ length: 8 }, (_, i) => message(i))),
      scope,
      {},
    )

    expect(page.items).toHaveLength(8)
    expect(page.nextCursor).toBeNull()
  })

  it('returns eight messages and resumes after the last returned message', async () => {
    const source = repository(Array.from({ length: 9 }, (_, i) => message(9 - i)))
    const first = await listMessages(source, scope, { folder: 'archive' })

    expect(first.items.map((item) => item.id)).toEqual(
      Array.from({ length: 8 }, (_, i) => message(9 - i).id),
    )
    expect(first.nextCursor).toBeTypeOf('string')
    await listMessages(source, scope, { folder: 'archive', cursor: first.nextCursor ?? '' })
    expect(source.findMessages).toHaveBeenLastCalledWith({
      ...scope,
      folder: 'archive',
      search: '',
      cursor: { id: message(2).id, receivedAt: message(2).receivedAt },
    })
  })

  it('trims search before delegating it to the repository', async () => {
    const source = repository()

    await listMessages(source, scope, { q: '  Invoice %_\\  ' })
    expect(source.findMessages).toHaveBeenCalledWith({
      ...scope,
      folder: 'inbox',
      search: 'Invoice %_\\',
      cursor: null,
    })
    await listMessages(source, scope, { q: '   ' })
    expect(source.findMessages).toHaveBeenLastCalledWith({
      ...scope,
      folder: 'inbox',
      search: '',
      cursor: null,
    })
  })

  it.each([
    '',
    'not-a-cursor',
    'a===',
    encode({ receivedAt: 'not-a-date', id: message(1).id }),
    encode({ receivedAt: '2026-02-30T12:00:00.000Z', id: message(1).id }),
    encode({ receivedAt: '2026-10-01T12:00:00.000Z', id: 'not-a-uuid' }),
    encode({ receivedAt: '2026-10-01T12:00:00.000Z', id: message(1).id, extra: true }),
    encode({ id: message(1).id }),
    encode(null),
    encode([]),
    'a'.repeat(513),
  ])('rejects malformed cursor %s without accessing the repository', async (cursor) => {
    const source = repository()

    await expect(listMessages(source, scope, { cursor })).rejects.toBeInstanceOf(
      InvalidMessageCursorError,
    )
    expect(source.findMessages).not.toHaveBeenCalled()
  })

  it('propagates database errors', async () => {
    const source = repository()
    source.findMessages.mockRejectedValue(new Error('database unavailable'))

    await expect(listMessages(source, scope, {})).rejects.toThrow('database unavailable')
  })
})
