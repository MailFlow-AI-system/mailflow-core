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
      sort: 'newest',
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
        sort: 'newest',
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
      sort: 'newest',
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
      sort: 'newest',
      cursor: null,
    })
    await listMessages(source, scope, { q: '   ' })
    expect(source.findMessages).toHaveBeenLastCalledWith({
      ...scope,
      folder: 'inbox',
      search: '',
      sort: 'newest',
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
    'a'.repeat(4097),
  ])('rejects malformed cursor %s without accessing the repository', async (cursor) => {
    const source = repository()

    await expect(listMessages(source, scope, { cursor })).rejects.toBeInstanceOf(
      InvalidMessageCursorError,
    )
    expect(source.findMessages).not.toHaveBeenCalled()
  })

  const decode = (cursor: string | null) =>
    JSON.parse(Buffer.from(cursor ?? '', 'base64url').toString('utf8'))
  const page = (items: InboxMessage[]) => repository(items)
  const nine = () => Array.from({ length: 9 }, (_, i) => message(9 - i))

  it.each([
    ['newest', { sort: 'newest', receivedAt: '2026-10-01T12:00:00.000Z' }, 'receivedAt'],
    ['oldest', { sort: 'oldest', receivedAt: '2026-10-01T12:00:00.000Z' }, 'receivedAt'],
    ['sender-asc', { sort: 'sender-asc', key: 'Sender 2' }, 'key'],
    ['sender-desc', { sort: 'sender-desc', key: 'Sender 2' }, 'key'],
    ['subject-asc', { sort: 'subject-asc', key: 'Subject 2' }, 'key'],
    ['subject-desc', { sort: 'subject-desc', key: 'Subject 2' }, 'key'],
  ] as const)(
    'encodes the %s sort and its key in the cursor and resumes from it',
    async (sort, payload, field) => {
      const source = page(nine())
      const first = await listMessages(source, scope, { sort })

      expect(source.findMessages).toHaveBeenLastCalledWith({
        ...scope,
        folder: 'inbox',
        search: '',
        sort,
        cursor: null,
      })
      expect(decode(first.nextCursor)).toEqual({ ...payload, id: message(2).id })

      await listMessages(source, scope, { sort, cursor: first.nextCursor ?? '' })
      expect(source.findMessages).toHaveBeenLastCalledWith({
        ...scope,
        folder: 'inbox',
        search: '',
        sort,
        cursor:
          field === 'receivedAt'
            ? { id: message(2).id, receivedAt: message(2).receivedAt }
            : { id: message(2).id, key: payload[field] },
      })
    },
  )

  it('accepts a legacy cursor without a sort as a newest cursor only', async () => {
    const legacy = encode({ receivedAt: '2026-10-01T12:00:00.000Z', id: message(1).id })
    const source = page([])

    await listMessages(source, scope, { cursor: legacy })
    expect(source.findMessages).toHaveBeenLastCalledWith({
      ...scope,
      folder: 'inbox',
      search: '',
      sort: 'newest',
      cursor: { id: message(1).id, receivedAt: new Date('2026-10-01T12:00:00.000Z') },
    })
    await expect(
      listMessages(source, scope, { sort: 'oldest', cursor: legacy }),
    ).rejects.toBeInstanceOf(InvalidMessageCursorError)
  })

  it.each([
    ['sender-asc', 'subject-asc'],
    ['sender-asc', 'sender-desc'],
    ['newest', 'oldest'],
    ['oldest', 'newest'],
    ['subject-desc', 'newest'],
  ] as const)('rejects a %s cursor on a %s request', async (issuedFor, requested) => {
    const first = await listMessages(page(nine()), scope, { sort: issuedFor })
    const source = page([])

    await expect(
      listMessages(source, scope, { sort: requested, cursor: first.nextCursor ?? '' }),
    ).rejects.toBeInstanceOf(InvalidMessageCursorError)
    expect(source.findMessages).not.toHaveBeenCalled()
  })

  it('bounds a text cursor key to the first 256 code points', async () => {
    const long = `${'😀'.repeat(300)}`
    const items = nine().map((item) => ({ ...item, subject: long }))
    const first = await listMessages(page(items), scope, { sort: 'subject-asc' })

    expect(decode(first.nextCursor).key).toBe('😀'.repeat(256))
    await listMessages(page([]), scope, { sort: 'subject-asc', cursor: first.nextCursor ?? '' })
  })

  it.each([
    ['sender-asc', { sort: 'sender-asc', key: 'a'.repeat(257), id: message(1).id }],
    [
      'sender-asc',
      { sort: 'sender-asc', receivedAt: '2026-10-01T12:00:00.000Z', id: message(1).id },
    ],
    ['newest', { sort: 'newest', key: 'Sender', id: message(1).id }],
    ['sender-asc', { sort: 'sender-asc', key: 7, id: message(1).id }],
    ['newest', { sort: 'unknown', key: 'Sender', id: message(1).id }],
    ['subject-asc', { sort: 'subject-asc', key: 'Subject', id: message(1).id, extra: true }],
    ['subject-asc', { sort: 'subject-asc', id: message(1).id }],
    // PostgreSQL text cannot hold NUL, so such a key could only fail in the database.
    ['sender-desc', { sort: 'sender-desc', key: 'Sen\u0000der', id: message(1).id }],
    ['oldest', { sort: 'oldest', receivedAt: '2026-02-30T12:00:00.000Z', id: message(1).id }],
  ] as const)('rejects a malformed %s cursor %j', async (sort, payload) => {
    const source = page([])
    await expect(
      listMessages(source, scope, { sort, cursor: encode(payload) }),
    ).rejects.toBeInstanceOf(InvalidMessageCursorError)
    expect(source.findMessages).not.toHaveBeenCalled()
  })

  it('propagates database errors', async () => {
    const source = repository()
    source.findMessages.mockRejectedValue(new Error('database unavailable'))

    await expect(listMessages(source, scope, {})).rejects.toThrow('database unavailable')
  })
})
