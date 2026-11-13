import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolveCapabilities } from '#modules/identityWorkspace'

import { createApp } from '../../../../app.js'
import { createMailMessageRepository } from '../../infrastructure/database/mailMessageRepository.js'
import { messages } from '../../infrastructure/database/schema/messages.js'
import {
  inUserWorkspaceTransaction,
  inWorkspaceTransaction,
} from '../../infrastructure/database/workspaceTransaction.js'
import type { ListMessagesResponse, MessageDetail, UnreadCounts } from '../listMessages/types.js'
import type { MailFolder, MessageActionResult } from './contract.js'

const databaseUrl =
  process.env.MAILFLOW_MAIL_INTEGRATION_DATABASE_URL ??
  'postgresql://mailflow:mailflow@localhost:5432/mailflow'
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname))
  throw new Error('Mail integration tests require a disposable local PostgreSQL instance')

const origin = 'http://localhost:3000'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
// Twelve messages, newest first, with timestamp ties every three messages.
const fixtures = Array.from({ length: 12 }, (_, index) => ({
  id: id(12 - index),
  workspaceId: 'workspace-a',
  senderName: `Sender ${index}`,
  subject: index % 2 === 0 ? `Invoice ${index}` : `Update ${index}`,
  body: `Body ${index}`,
  receivedAt: new Date(Date.UTC(2026, 9, 1, 12, 0, -Math.floor(index / 3))),
}))
const ids = fixtures.map((fixture) => fixture.id)
const foreignId = id(99)

function makeApp(repository: ReturnType<typeof createMailMessageRepository>) {
  return createApp({
    config: {
      appEnv: 'development',
      databaseUrl,
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'silent',
      apiDocsEnabled: false,
      serviceVersion: 'test',
      otlpEndpoint: undefined,
      otelTraceSampleRate: 0,
      serviceInstanceId: 'mail-actions-integration-test',
    },
    logger: pino({ enabled: false }),
    checkDatabase: async () => {},
    auth: {
      handler: async () => new Response(),
      api: {
        getSession: async ({ headers }) => {
          const user = /^test-session=(user-[ab])$/.exec(headers.get('Cookie') ?? '')?.[1]
          return user ? { session: { id: `session-${user}` }, user: { id: user } } : null
        },
      },
    },
    allowedAuthOrigins: [origin],
    mailRepository: repository,
    workspaces: {
      reader: {
        list: async () => ({ items: [], nextCursor: null }),
        // Both users share workspace A; only user A also belongs to workspace B.
        context: async (userId, slug) => {
          if (slug === 'acme')
            return {
              id: 'workspace-a',
              name: 'Acme',
              slug,
              role: userId === 'user-a' ? 'owner' : 'member',
              capabilities: resolveCapabilities(userId === 'user-a' ? 'owner' : 'member'),
            }
          if (slug === 'beta' && userId === 'user-a')
            return {
              id: 'workspace-b',
              name: 'Beta',
              slug,
              role: 'owner',
              capabilities: resolveCapabilities('owner'),
            }
          return null
        },
      },
      consumeBudget: async () => {
        throw new Error('Mail must not consume discovery budget')
      },
    },
  })
}

describe('Message actions PostgreSQL integration', () => {
  const suffix = randomUUID().replaceAll('-', '')
  const databaseName = `mail_actions_test_${suffix}`
  const role = `mail_actions_app_${suffix}`
  const admin = new Pool({ connectionString: databaseUrl })
  let owner: Pool
  let pool: Pool
  let app: ReturnType<typeof makeApp>

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'mail_test_local_only' NOSUPERUSER NOBYPASSRLS`,
    )
    const ownerUrl = new URL(databaseUrl)
    ownerUrl.pathname = `/${databaseName}`
    owner = new Pool({ connectionString: ownerUrl.href })
    await migrate(drizzle(owner), {
      migrationsFolder: './database/migrations/mail',
      migrationsSchema: 'mail_migrations',
      migrationsTable: '__drizzle_migrations',
    })
    await owner.query(`GRANT USAGE ON SCHEMA mail TO "${role}";
      GRANT SELECT, INSERT, UPDATE, DELETE ON mail.message, mail.message_user_state TO "${role}";
      GRANT SELECT ON mail.attachment, mail.inbox_message_attachment, mail.label, mail.message_label TO "${role}"`)
    ownerUrl.username = role
    ownerUrl.password = 'mail_test_local_only'
    pool = new Pool({ connectionString: ownerUrl.href, max: 2 })
    app = makeApp(createMailMessageRepository(pool))
  }, 30_000)

  beforeEach(async () => {
    await owner.query('DELETE FROM mail.message')
    await owner.query('DELETE FROM mail.label')
    await inWorkspaceTransaction(pool, 'workspace-a', (client) =>
      drizzle({ client }).insert(messages).values(fixtures),
    )
    await inWorkspaceTransaction(pool, 'workspace-b', (client) =>
      drizzle({ client })
        .insert(messages)
        .values({
          id: foreignId,
          workspaceId: 'workspace-b',
          senderName: 'Foreign sender',
          subject: 'Invoice foreign',
          body: 'Foreign body',
          receivedAt: new Date(Date.UTC(2026, 9, 1, 12)),
        }),
    )
  })

  afterAll(async () => {
    await pool?.end()
    await owner?.end()
    try {
      const deadline = Date.now() + 5000
      while (
        (await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1', [databaseName]))
          .rowCount
      ) {
        if (Date.now() >= deadline) throw new Error('Mail test connections did not close')
        await delay(10)
      }
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.query(`DROP ROLE IF EXISTS "${role}"`)
    } finally {
      await admin.end()
    }
  }, 30_000)

  const headers = (user: 'user-a' | 'user-b') => ({
    Cookie: `test-session=${user}`,
    Origin: origin,
    'Content-Type': 'application/json',
  })

  async function list(user: 'user-a' | 'user-b', query = '', slug = 'acme') {
    const response = await app.request(`/api/v1/workspaces/${slug}/mail/messages${query}`, {
      headers: headers(user),
    })
    expect(response.status).toBe(200)
    return (await response.json()) as ListMessagesResponse
  }

  async function folder(user: 'user-a' | 'user-b', name: MailFolder) {
    const items: ListMessagesResponse['items'] = []
    let cursor: string | null = null
    do {
      const page: ListMessagesResponse = await list(
        user,
        `?folder=${name}${cursor ? `&cursor=${cursor}` : ''}`,
      )
      items.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    return items.map((item) => item.id)
  }

  async function patch(user: 'user-a' | 'user-b', messageId: string, body: unknown, slug = 'acme') {
    return app.request(`/api/v1/workspaces/${slug}/mail/messages/${messageId}`, {
      method: 'PATCH',
      headers: headers(user),
      body: JSON.stringify(body),
    })
  }

  async function bulk(user: 'user-a' | 'user-b', body: unknown) {
    const response = await app.request('/api/v1/workspaces/acme/mail/messages/actions', {
      method: 'POST',
      headers: headers(user),
      body: JSON.stringify(body),
    })
    return {
      status: response.status,
      body: (await response.json()) as { results: MessageActionResult[] },
    }
  }

  async function counts(user: 'user-a' | 'user-b') {
    const response = await app.request('/api/v1/workspaces/acme/mail/unread-counts', {
      headers: headers(user),
    })
    expect(response.status).toBe(200)
    return (await response.json()) as UnreadCounts
  }

  async function storedState(messageId: string) {
    return (
      await owner.query(
        'SELECT archived_at, archived_by, trashed_at, trashed_by, spam_at, spam_by FROM mail.message WHERE id=$1',
        [messageId],
      )
    ).rows[0]
  }

  it('lists every message as unread and unstarred in the inbox by default', async () => {
    const page = await list('user-a')
    expect(page.items.map((item) => item.id)).toEqual(ids.slice(0, 8))
    expect(page.items[0]).toMatchObject({
      isRead: false,
      isStarred: false,
      folder: 'inbox',
      archivedAt: null,
      archivedBy: null,
      trashedAt: null,
      trashedBy: null,
      spamAt: null,
      spamBy: null,
    })
  })

  it('keeps read and star state per user within one workspace', async () => {
    const [first = '', second = ''] = ids
    expect((await patch('user-a', first, { read: true, starred: true })).status).toBe(200)
    expect((await bulk('user-b', { ids: [second], action: 'star' })).status).toBe(200)

    const forA = (await list('user-a')).items
    const forB = (await list('user-b')).items
    expect(forA.find((item) => item.id === first)).toMatchObject({ isRead: true, isStarred: true })
    expect(forB.find((item) => item.id === first)).toMatchObject({
      isRead: false,
      isStarred: false,
    })
    expect(forA.find((item) => item.id === second)).toMatchObject({ isStarred: false })
    expect(await folder('user-a', 'starred')).toEqual([first])
    expect(await folder('user-b', 'starred')).toEqual([second])

    // RLS hides another member's rows even without an explicit user predicate.
    const visible = await inUserWorkspaceTransaction(pool, 'workspace-a', 'user-a', (client) =>
      client.query('SELECT user_id FROM mail.message_user_state'),
    )
    expect(visible.rows).toEqual([{ user_id: 'user-a' }])
  })

  it('marks a message read on detail for the opener only and keeps the first read time', async () => {
    const [first = ''] = ids
    const open = async (user: 'user-a' | 'user-b') => {
      const response = await app.request(`/api/v1/workspaces/acme/mail/messages/${first}`, {
        headers: headers(user),
      })
      expect(response.status).toBe(200)
      return (await response.json()) as MessageDetail
    }
    expect(await open('user-a')).toMatchObject({ id: first, isRead: true, folder: 'inbox' })
    const readAt = (
      await owner.query(
        "SELECT read_at FROM mail.message_user_state WHERE user_id='user-a' AND message_id=$1",
        [first],
      )
    ).rows[0]?.read_at
    expect(readAt).toBeInstanceOf(Date)
    await delay(5)
    await open('user-a')
    expect(
      (
        await owner.query(
          "SELECT read_at FROM mail.message_user_state WHERE user_id='user-a' AND message_id=$1",
          [first],
        )
      ).rows[0]?.read_at,
    ).toEqual(readAt)
    expect((await list('user-a')).items[0]?.isRead).toBe(true)
    expect((await list('user-b')).items[0]?.isRead).toBe(false)
  })

  it('shares folder state with the workspace and records the actor', async () => {
    const [first = ''] = ids
    const response = await patch('user-a', first, { archived: true })
    expect(response.status).toBe(200)
    const state = await response.json()
    expect(state).toMatchObject({
      id: first,
      folder: 'archive',
      archivedBy: 'user-a',
      isRead: false,
    })
    expect(Date.parse(state.archivedAt)).not.toBeNaN()
    expect(await folder('user-b', 'inbox')).not.toContain(first)
    expect(await folder('user-b', 'archive')).toEqual([first])
    expect((await list('user-b', '?folder=archive')).items[0]).toMatchObject({
      archivedBy: 'user-a',
      archivedAt: state.archivedAt,
    })
  })

  it('applies trash > spam > archive precedence and keeps archived stars visible', async () => {
    const [a, b, c, d, e, f] = ids as [string, string, string, string, string, string]
    await patch('user-a', a, { archived: true })
    await patch('user-a', b, { archived: true, trashed: true })
    await patch('user-a', c, { archived: true, spam: true })
    await patch('user-a', d, { spam: true, trashed: true })
    await patch('user-a', e, { archived: true, starred: true })
    await patch('user-a', f, { trashed: true, starred: true })

    expect(await folder('user-a', 'inbox')).toEqual(ids.slice(6))
    expect(await folder('user-a', 'archive')).toEqual([a, e])
    expect(await folder('user-a', 'trash')).toEqual([b, d, f])
    expect(await folder('user-a', 'spam')).toEqual([c])
    expect(await folder('user-a', 'starred')).toEqual([e])
    expect((await list('user-a', '?folder=trash')).items.map((item) => item.folder)).toEqual([
      'trash',
      'trash',
      'trash',
    ])

    // Restoring clears only the trash pair, so the message returns to its previous folder.
    const restored = await patch('user-a', b, { trashed: false })
    expect(await restored.json()).toMatchObject({
      folder: 'archive',
      trashedAt: null,
      trashedBy: null,
    })
  })

  it('combines search with the folder before paginating', async () => {
    await bulk('user-a', { ids: ids.slice(0, 6), action: 'archive' })
    expect(await folder('user-a', 'archive')).toEqual(ids.slice(0, 6))
    const archivedInvoices = await list('user-a', '?folder=archive&q=invoice')
    expect(archivedInvoices.items.map((item) => item.id)).toEqual([ids[0], ids[2], ids[4]])
    const inboxInvoices = await list('user-a', '?q=INVOICE')
    expect(inboxInvoices.items.map((item) => item.id)).toEqual([ids[6], ids[8], ids[10]])
  })

  it('paginates each folder across timestamp ties without gaps or duplicates', async () => {
    await bulk('user-a', { ids: ids.slice(0, 10), action: 'trash' })
    const first = await list('user-a', '?folder=trash')
    expect(first.items).toHaveLength(8)
    const second = await list('user-a', `?folder=trash&cursor=${first.nextCursor}`)
    expect(second.items).toHaveLength(2)
    expect(second.nextCursor).toBeNull()
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(ids.slice(0, 10))
    expect(await folder('user-a', 'inbox')).toEqual(ids.slice(10))
  })

  it('is idempotent and keeps the original actor and timestamps', async () => {
    const [first = ''] = ids
    const once = await (await patch('user-a', first, { archived: true, read: true })).json()
    await delay(5)
    const twice = await (await patch('user-b', first, { archived: true })).json()
    expect(twice).toMatchObject({ archivedAt: once.archivedAt, archivedBy: 'user-a' })
    const again = await bulk('user-a', { ids: [first], action: 'read' })
    expect(again.body.results).toEqual([{ id: first, status: 'ok' }])
    expect((await list('user-a', '?folder=archive')).items[0]?.isRead).toBe(true)
    await patch('user-a', first, { archived: false })
    expect(await storedState(first)).toMatchObject({ archived_at: null, archived_by: null })
    expect((await bulk('user-a', { ids: [first], action: 'unarchive' })).body.results).toEqual([
      { id: first, status: 'ok' },
    ])
  })

  it('reports bulk results per id for mixed, missing, and foreign ids', async () => {
    const [first = '', second = ''] = ids
    const missing = id(500)
    const result = await bulk('user-a', {
      ids: [first, missing, foreignId, second, first],
      action: 'spam',
    })
    expect(result.status).toBe(200)
    expect(result.body.results).toEqual([
      { id: first, status: 'ok' },
      { id: missing, status: 'not_found' },
      { id: foreignId, status: 'not_found' },
      { id: second, status: 'ok' },
    ])
    expect(await folder('user-a', 'spam')).toEqual([first, second])
    expect(await storedState(first)).toMatchObject({ spam_by: 'user-a' })
    const foreign = await inWorkspaceTransaction(pool, 'workspace-b', (client) =>
      client.query('SELECT spam_at FROM mail.message WHERE id=$1', [foreignId]),
    )
    expect(foreign.rows).toEqual([{ spam_at: null }])
  })

  it('rejects more than 100 ids', async () => {
    const tooMany = Array.from({ length: 101 }, (_, n) => id(1000 + n))
    expect((await bulk('user-a', { ids: tooMany, action: 'read' })).status).toBe(400)
  })

  it('deletes permanently only from Trash, for the whole workspace', async () => {
    const [first = '', second = ''] = ids
    const labelId = randomUUID()
    await owner.query(
      "INSERT INTO mail.label (workspace_id, id, name, color) VALUES ('workspace-a', $1, 'Keep', '#2563eb')",
      [labelId],
    )
    await owner.query(
      "INSERT INTO mail.message_label (workspace_id, message_id, label_id) VALUES ('workspace-a', $1, $2)",
      [first, labelId],
    )
    await patch('user-a', first, { read: true })
    await patch('user-b', first, { starred: true })
    const remove = (messageId: string, user: 'user-a' | 'user-b' = 'user-a') =>
      app.request(`/api/v1/workspaces/acme/mail/messages/${messageId}`, {
        method: 'DELETE',
        headers: headers(user),
      })

    const outside = await remove(first)
    expect(outside.status).toBe(409)
    expect(await outside.json()).toMatchObject({ code: 'message_not_in_trash' })
    expect(await storedState(first)).toBeDefined()

    await patch('user-a', first, { trashed: true })
    expect((await remove(first, 'user-b')).status).toBe(204)
    expect(await storedState(first)).toBeUndefined()
    expect(
      (await owner.query('SELECT 1 FROM mail.message_label WHERE message_id=$1', [first])).rowCount,
    ).toBe(0)
    expect(
      (await owner.query('SELECT 1 FROM mail.message_user_state WHERE message_id=$1', [first]))
        .rowCount,
    ).toBe(0)
    expect((await remove(first)).status).toBe(404)
    expect((await remove(foreignId)).status).toBe(404)

    await patch('user-a', second, { trashed: true })
    const mixed = await bulk('user-a', {
      ids: [second, ids[2], id(500)],
      action: 'delete_permanently',
    })
    expect(mixed.body.results).toEqual([
      { id: second, status: 'ok' },
      { id: ids[2], status: 'invalid_state' },
      { id: id(500), status: 'not_found' },
    ])
    expect(await storedState(ids[2] ?? '')).toBeDefined()
  })

  it('isolates workspaces for actions and lists', async () => {
    const [first = ''] = ids
    expect((await patch('user-a', first, { archived: true }, 'beta')).status).toBe(404)
    expect((await patch('user-a', foreignId, { read: true })).status).toBe(404)
    expect((await patch('user-b', first, { read: true }, 'beta')).status).toBe(404)
    expect(await storedState(first)).toMatchObject({ archived_at: null })
    expect((await list('user-a', '', 'beta')).items.map((item) => item.id)).toEqual([foreignId])
  })

  it('counts unread messages per folder for the current user', async () => {
    const [a, b, c, d, e] = ids as [string, string, string, string, string]
    await bulk('user-a', { ids: [a, b], action: 'read' })
    await patch('user-a', c, { spam: true })
    await patch('user-a', d, { trashed: true, read: true })
    await patch('user-a', e, { archived: true, starred: true })

    expect(await counts('user-a')).toEqual({ inbox: 7, starred: 1, archive: 1, trash: 0, spam: 1 })
    expect(await counts('user-b')).toEqual({ inbox: 9, starred: 0, archive: 1, trash: 1, spam: 1 })
  })
})
