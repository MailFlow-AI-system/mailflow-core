import { drizzle } from 'drizzle-orm/node-postgres'
import type { PoolClient } from 'pg'
import pino from 'pino'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../../../app.js'
import { createDatabase } from '../../../../shared/database/client.js'
import { createMailMessageRepository } from '../../infrastructure/database/mailMessageRepository.js'
import { messages } from '../../infrastructure/database/schema/messages.js'
import { seedMailMessages } from '../../seed/fixtures.js'
import { seedMail } from '../../seed/seedMail.js'
import type { ListMessagesResponse, MailMessage } from './types.js'

const databaseUrl = process.env.MAILFLOW_MAIL_INTEGRATION_DATABASE_URL
const describeIntegration = databaseUrl === undefined ? describe.skip : describe
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
  })
}

describeIntegration('Inbox PostgreSQL integration (MAILFLOW_MAIL_INTEGRATION_DATABASE_URL)', () => {
  const database = createDatabase(
    databaseUrl ?? 'postgresql://invalid:invalid@localhost:5432/invalid',
    logger,
  )
  let client: PoolClient
  let app: ReturnType<typeof makeApp>

  beforeAll(async () => {
    client = await database.pool.connect()
    app = makeApp(createMailMessageRepository(drizzle({ client })))
  })

  beforeEach(async () => {
    await client.query('BEGIN')
    await client.query('DELETE FROM mail.message')
    await drizzle({ client }).insert(messages).values(fixtures)
  })

  afterEach(async () => {
    await client.query('ROLLBACK')
  })

  afterAll(async () => {
    client?.release()
    await database.pool.end()
  })

  async function getPage(query = '') {
    const response = await app.request(`/api/v1/mail/messages${query}`, {
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
    const response = await app.request('/api/v1/mail/messages?cursor=invalid', {
      headers: { Cookie: 'test-session=valid' },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid_message_cursor' })
  })

  it('requires an authenticated session', async () => {
    const response = await app.request('/api/v1/mail/messages')

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'authentication_required' })
  })

  it('returns a safe failure when the database connection is closed', async () => {
    const closedDatabase = createDatabase(databaseUrl ?? '', logger)
    await closedDatabase.pool.end()
    const failedApp = makeApp(createMailMessageRepository(closedDatabase.database))
    const response = await failedApp.request('/api/v1/mail/messages', {
      headers: { Cookie: 'test-session=valid' },
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: 'internal_error' })
  })

  it('seeds exactly 33 messages idempotently without changing existing messages', async () => {
    const connection = drizzle({ client })

    expect(await seedMail(connection)).toBe(33)
    expect(await seedMail(connection)).toBe(0)
    const stored = await connection.select().from(messages)
    expect(stored).toHaveLength(fixtures.length + seedMailMessages.length)
    for (const original of fixtures) {
      expect(stored.find((message) => message.id === original.id)).toEqual(original)
    }
    for (const seeded of seedMailMessages) {
      expect(stored.find((message) => message.id === seeded.id)).toEqual(seeded)
    }
  })
})
