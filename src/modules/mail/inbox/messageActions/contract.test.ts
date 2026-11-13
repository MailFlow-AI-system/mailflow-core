import { describe, expect, it } from 'vitest'
import {
  actionPatch,
  changesWorkspaceState,
  folderOf,
  messageActionsSchema,
  messagePatchSchema,
} from './contract.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('message patch body', () => {
  it('accepts any non-empty subset of the boolean fields', () => {
    expect(messagePatchSchema.parse({ read: true })).toEqual({ read: true })
    expect(
      messagePatchSchema.parse({
        read: false,
        starred: true,
        archived: true,
        trashed: false,
        spam: true,
      }),
    ).toEqual({ read: false, starred: true, archived: true, trashed: false, spam: true })
  })

  it.each([{}, { read: 'yes' }, { pinned: true }, { read: null }, null, []])(
    'rejects %j',
    (body) => {
      expect(messagePatchSchema.safeParse(body).success).toBe(false)
    },
  )
})

describe('bulk message actions body', () => {
  it('deduplicates ids case-insensitively and keeps the first-seen order', () => {
    expect(
      messageActionsSchema.parse({
        ids: [id(2), id(1), id(2), id(1).toUpperCase()],
        action: 'archive',
      }),
    ).toEqual({ ids: [id(2), id(1)], action: 'archive' })
  })

  it('accepts exactly 100 ids and rejects 101', () => {
    const ids = Array.from({ length: 101 }, (_, n) => id(n))
    expect(messageActionsSchema.safeParse({ ids: ids.slice(0, 100), action: 'read' }).success).toBe(
      true,
    )
    expect(messageActionsSchema.safeParse({ ids, action: 'read' }).success).toBe(false)
  })

  it.each([
    { ids: [], action: 'read' },
    { ids: ['not-a-uuid'], action: 'read' },
    { ids: [id(1)], action: 'move' },
    { ids: [id(1)] },
    { ids: [id(1)], action: 'read', extra: true },
  ])('rejects %j', (body) => {
    expect(messageActionsSchema.safeParse(body).success).toBe(false)
  })
})

describe('action semantics', () => {
  it.each([
    ['read', { read: true }, false],
    ['unread', { read: false }, false],
    ['star', { starred: true }, false],
    ['unstar', { starred: false }, false],
    ['archive', { archived: true }, true],
    ['unarchive', { archived: false }, true],
    ['trash', { trashed: true }, true],
    ['restore', { trashed: false }, true],
    ['spam', { spam: true }, true],
    ['not_spam', { spam: false }, true],
  ] as const)('maps %s to %j (workspace state: %s)', (action, patch, workspace) => {
    expect(actionPatch(action)).toEqual(patch)
    expect(changesWorkspaceState(patch)).toBe(workspace)
  })

  it('applies trash > spam > archive precedence', () => {
    const at = '2026-10-01T12:00:00.000Z'
    expect(folderOf({ archivedAt: null, trashedAt: null, spamAt: null })).toBe('inbox')
    expect(folderOf({ archivedAt: at, trashedAt: null, spamAt: null })).toBe('archive')
    expect(folderOf({ archivedAt: at, trashedAt: null, spamAt: at })).toBe('spam')
    expect(folderOf({ archivedAt: at, trashedAt: at, spamAt: at })).toBe('trash')
  })
})
