import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../../../app.js'
import { createDatabase } from '../../../../shared/database/client.js'
import { assertMailDatabaseRole } from '../../infrastructure/database/databaseRole.js'
import { createMailMessageRepository } from '../../infrastructure/database/mailMessageRepository.js'
import { messages } from '../../infrastructure/database/schema/messages.js'
import { inWorkspaceTransaction } from '../../infrastructure/database/workspaceTransaction.js'
import { seedMailMessages } from '../../seed/fixtures.js'
import { mailSeedId, seedMail } from '../../seed/seedMail.js'
import type { ListMessagesResponse, MailMessage } from './types.js'

const databaseUrl =
  process.env.MAILFLOW_MAIL_INTEGRATION_DATABASE_URL ??
  'postgresql://mailflow:mailflow@localhost:5432/mailflow'
const localUrl = new URL(databaseUrl)
if (!['localhost', '127.0.0.1', '[::1]'].includes(localUrl.hostname))
  throw new Error('Mail integration tests require a disposable local PostgreSQL instance')
const logger = pino({ enabled: false })

const fixtures: MailMessage[] = Array.from({ length: 18 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(18 - index).padStart(12, '0')}`,
  senderName: index === 16 ? 'Lighthouse Operations' : `Sender ${index}`,
  subject: index === 15 ? 'Late Invoice Confirmation' : `Subject ${index}`,
  body:
    index === 17
      ? `${'Full body content. '.repeat(30)}AuroraLedger reference appears after the preview.`
      : index === 4
        ? 'Completion is 100% accurate.'
        : index === 5
          ? 'Attachment invoice_final.pdf is ready.'
          : index === 6
            ? 'Shared folder C:\\reports is ready.'
            : `Complete message body ${index}`,
  receivedAt: new Date(Date.UTC(2026, 9, 1, 12, 0, -Math.floor(index / 3))),
}))

function makeApp(repository: ReturnType<typeof createMailMessageRepository>) {
  return createApp({
    config: {
      appEnv: 'development',
      databaseUrl: databaseUrl ?? '',
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'silent',
      apiDocsEnabled: false,
      serviceVersion: 'test',
      otlpEndpoint: undefined,
      otelTraceSampleRate: 0.1,
      serviceInstanceId: 'mail-integration-test',
    },
    logger,
    checkDatabase: async () => {},
    auth: {
      handler: async () => new Response(),
      api: {
        getSession: async ({ headers }) =>
          headers.get('Cookie') === 'test-session=valid'
            ? { session: { id: 'session' }, user: { id: 'user' } }
            : null,
      },
    },
    allowedAuthOrigins: ['http://localhost:3000'],
    mailRepository: repository,
    workspaces: {
      reader: {
        list: async () => ({ items: [], nextCursor: null }),
        context: async (userId, slug) =>
          slug === 'acme' && userId === 'user'
            ? { id: 'workspace-a', name: 'Acme', slug, role: 'owner' }
            : null,
      },
      consumeBudget: async () => {
        throw new Error('Mail must not consume discovery budget')
      },
    },
  })
}

describe('Workspace Inbox PostgreSQL integration', () => {
  const suffix = randomUUID().replaceAll('-', '')
  const databaseName = `mail_test_${suffix}`
  const role = `mail_app_${suffix}`
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
      GRANT SELECT, INSERT, UPDATE, DELETE ON mail.message TO "${role}"`)
    ownerUrl.username = role
    ownerUrl.password = 'mail_test_local_only'
    pool = new Pool({ connectionString: ownerUrl.href, max: 1 })
    await assertMailDatabaseRole(pool)
    app = makeApp(createMailMessageRepository(pool))
  }, 30_000)

  beforeEach(async () => {
    await owner.query('DELETE FROM mail.message')
    await inWorkspaceTransaction(pool, 'workspace-a', async (client) => {
      await drizzle(client)
        .insert(messages)
        .values(fixtures.map((message) => ({ ...message, workspaceId: 'workspace-a' })))
    })
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

  async function getPage(query = '') {
    const response = await app.request(`/api/v1/workspaces/acme/mail/messages${query}`, {
      headers: { Cookie: 'test-session=valid' },
    })
    expect(response.status).toBe(200)
    return (await response.json()) as ListMessagesResponse
  }

  it('paginates eight at a time across timestamp ties, returns the partial page, then ends', async () => {
    const first = await getPage()
    const second = await getPage(`?cursor=${first.nextCursor}`)
    const third = await getPage(`?cursor=${second.nextCursor}`)

    expect(first.items).toHaveLength(8)
    expect(second.items).toHaveLength(8)
    expect(third.items).toHaveLength(2)
    expect(third.nextCursor).toBeNull()
    const all = [...first.items, ...second.items, ...third.items]
    expect(all.map((message) => message.id)).toEqual(fixtures.map((message) => message.id))
    expect(new Set(all.map((message) => message.id)).size).toBe(18)
  })

  it('returns an empty page when the cursor is older than every message', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ receivedAt: '2020-01-01T00:00:00.000Z', id: fixtures[0]?.id }),
    ).toString('base64url')

    expect(await getPage(`?cursor=${cursor}`)).toEqual({ items: [], nextCursor: null })
  })

  it.each([
    [' lighthouse ', 16],
    ['late invoice', 15],
    ['AURORALEDGER', 17],
  ])('searches all stored senders, subjects and full bodies for %s', async (q, index) => {
    const page = await getPage(`?q=${encodeURIComponent(q)}`)

    expect(page.items.map((message) => message.id)).toEqual([fixtures[index]?.id])
    expect(page.items[0]?.body).toBe(fixtures[index]?.body)
    expect(page.nextCursor).toBeNull()
  })

  it('applies the search before pagination and preserves it on the next page', async () => {
    const first = await getPage('?q=complete')
    const second = await getPage(`?q=complete&cursor=${first.nextCursor}`)

    expect(first.items).toHaveLength(8)
    expect(second.items).toHaveLength(6)
    expect(second.nextCursor).toBeNull()
    expect([...first.items, ...second.items].map((message) => message.id)).toEqual(
      fixtures.filter((message) => message.body.includes('Complete')).map((message) => message.id),
    )
  })

  it('treats empty and whitespace-only search as the unfiltered inbox', async () => {
    expect(await getPage('?q=')).toEqual(await getPage())
    expect(await getPage('?q=%20%20')).toEqual(await getPage())
  })

  it.each([
    ['%', 4],
    ['_', 5],
    ['\\', 6],
  ])('treats SQL wildcard %s as a literal character', async (q, index) => {
    const page = await getPage(`?q=${encodeURIComponent(q)}`)

    expect(page.items.map((message) => message.id)).toEqual([fixtures[index]?.id])
  })

  it('binds hostile search text as data', async () => {
    expect(await getPage(`?q=${encodeURIComponent("%' OR TRUE --")}`)).toEqual({
      items: [],
      nextCursor: null,
    })
  })

  it('rejects malformed cursors with problem details', async () => {
    const response = await app.request('/api/v1/workspaces/acme/mail/messages?cursor=invalid', {
      headers: { Cookie: 'test-session=valid' },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid_message_cursor' })
  })

  it('requires an authenticated session', async () => {
    const response = await app.request('/api/v1/workspaces/acme/mail/messages')

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'authentication_required' })
  })

  it('returns a safe failure when the database connection is closed', async () => {
    const closedDatabase = createDatabase(databaseUrl ?? '', logger)
    await closedDatabase.pool.end()
    const failedApp = makeApp(createMailMessageRepository(closedDatabase.pool))
    const response = await failedApp.request('/api/v1/workspaces/acme/mail/messages', {
      headers: { Cookie: 'test-session=valid' },
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: 'internal_error' })
  })

  it('seeds 33 stable messages per workspace without collisions or changing existing messages', async () => {
    expect(await seedMail(pool, 'workspace-a')).toBe(33)
    expect(await seedMail(pool, 'workspace-a')).toBe(0)
    expect(await seedMail(pool, 'workspace-b')).toBe(33)
    const stored = await inWorkspaceTransaction(pool, 'workspace-a', (client) =>
      drizzle(client).select().from(messages),
    )
    expect(stored).toHaveLength(fixtures.length + seedMailMessages.length)
    for (const original of fixtures) {
      expect(stored.find((message) => message.id === original.id)).toEqual({
        ...original,
        workspaceId: 'workspace-a',
      })
    }
    for (const seeded of seedMailMessages) {
      expect(stored.find((message) => message.id === mailSeedId('workspace-a', seeded.id))).toEqual(
        { ...seeded, workspaceId: 'workspace-a', id: mailSeedId('workspace-a', seeded.id) },
      )
    }
  })

  it('isolates A and B with RLS even when the explicit workspace predicate is omitted', async () => {
    await seedMail(pool, 'workspace-b')
    const repository = createMailMessageRepository(pool)
    const a = await repository.findMessages({
      workspaceId: 'workspace-a',
      search: '',
      cursor: null,
    })
    const b = await repository.findMessages({
      workspaceId: 'workspace-b',
      search: '',
      cursor: null,
    })
    expect(a).toHaveLength(9)
    expect(b).toHaveLength(9)
    expect(a.every((message) => fixtures.some((fixture) => fixture.id === message.id))).toBe(true)
    expect(b.every((message) => !fixtures.some((fixture) => fixture.id === message.id))).toBe(true)
    const direct = await inWorkspaceTransaction(pool, 'workspace-a', (client) =>
      client.query('SELECT workspace_id FROM mail.message'),
    )
    expect(direct.rows).toHaveLength(fixtures.length)
    expect(direct.rows.every((row) => row.workspace_id === 'workspace-a')).toBe(true)
    const other = await inWorkspaceTransaction(pool, 'workspace-b', (client) =>
      client.query('SELECT workspace_id FROM mail.message'),
    )
    expect(other.rows).toHaveLength(33)
    expect(other.rows.every((row) => row.workspace_id === 'workspace-b')).toBe(true)
  })

  it('clears tenant context after commit and rollback on the same reused connection', async () => {
    const backend = await pool.query('SELECT pg_backend_pid() AS pid')
    expect((await pool.query('SELECT * FROM mail.message')).rows).toEqual([])
    await inWorkspaceTransaction(pool, 'workspace-a', async (client) => {
      expect((await client.query('SELECT pg_backend_pid() AS pid')).rows).toEqual(backend.rows)
      expect((await client.query('SELECT * FROM mail.message')).rows).toHaveLength(fixtures.length)
    })
    expect((await pool.query('SELECT * FROM mail.message')).rows).toEqual([])
    await expect(
      inWorkspaceTransaction(pool, 'workspace-a', async () => {
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect((await pool.query('SELECT pg_backend_pid() AS pid')).rows).toEqual(backend.rows)
    expect((await pool.query('SELECT * FROM mail.message')).rows).toEqual([])
  })

  it('rejects writes for another workspace through WITH CHECK', async () => {
    await expect(
      inWorkspaceTransaction(pool, 'workspace-a', (client) =>
        client.query(
          `INSERT INTO mail.message(id, workspace_id, sender_name, subject, body, received_at) VALUES ($1, 'workspace-b', 'Sender', 'Subject', 'Body', now())`,
          [randomUUID()],
        ),
      ),
    ).rejects.toThrow('row-level security')
  })

  it('rejects BYPASSRLS even when table RLS is forced', async () => {
    await admin.query(`ALTER ROLE "${role}" BYPASSRLS`)
    try {
      await expect(assertMailDatabaseRole(pool)).rejects.toThrow('BYPASSRLS')
    } finally {
      await admin.query(`ALTER ROLE "${role}" NOBYPASSRLS`)
    }
  })

  it('rejects inherited ownership of the mail table', async () => {
    const result = await owner.query<{ owner: string }>(
      `SELECT r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner WHERE n.nspname = 'mail' AND c.relname = 'message'`,
    )
    const tableOwner = result.rows[0]?.owner.replaceAll('"', '""')
    if (!tableOwner) throw new Error('Mail table owner is required')
    await admin.query(`GRANT "${tableOwner}" TO "${role}"`)
    try {
      await expect(assertMailDatabaseRole(pool)).rejects.toThrow('non-owner role')
    } finally {
      await admin.query(`REVOKE "${tableOwner}" FROM "${role}"`)
    }
  })

  it('rejects startup when the mail table is absent', async () => {
    await owner.query('ALTER TABLE mail.message RENAME TO hidden_message')
    try {
      await expect(assertMailDatabaseRole(pool)).rejects.toThrow('FORCE RLS')
    } finally {
      await owner.query('ALTER TABLE mail.hidden_message RENAME TO message')
    }
  })

  it('rejects unsafe startup roles and missing FORCE RLS', async () => {
    await expect(assertMailDatabaseRole(owner)).rejects.toThrow('non-owner role')
    await owner.query('ALTER TABLE mail.message NO FORCE ROW LEVEL SECURITY')
    try {
      await expect(assertMailDatabaseRole(pool)).rejects.toThrow('FORCE RLS')
    } finally {
      await owner.query('ALTER TABLE mail.message FORCE ROW LEVEL SECURITY')
    }
  })
})
