import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Client, Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAttachmentRepository } from '../infrastructure/database/attachmentRepository.js'
import { createOutgoingRepository } from '../infrastructure/database/outgoingRepository.js'
import { attachments } from '../infrastructure/database/schema/attachments.js'
import type { AttachmentRecord } from './types.js'

const databaseUrl = process.env.MAILFLOW_MAIL_INTEGRATION_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
integration('attachment PostgreSQL persistence', () => {
  const client = new Client({ connectionString: databaseUrl ?? 'postgresql://localhost/invalid' })
  const pool = new Pool({
    connectionString: databaseUrl ?? 'postgresql://localhost/invalid',
    max: 3,
  })
  const database = drizzle({ client: pool })
  const owner = `storage-persistence-${randomUUID()}`
  const foreignOwner = `storage-foreign-${randomUUID()}`
  const finalKey = (suffix: string) => `objects/${owner}/${suffix}`
  const repository = createAttachmentRepository(database)
  const outgoing = createOutgoingRepository(database)
  const record = (patch: Partial<AttachmentRecord> = {}): AttachmentRecord => ({
    id: randomUUID(),
    userId: owner,
    filename: 'hello.txt',
    contentType: 'text/plain',
    size: 5,
    sha256: 'a'.repeat(64),
    status: 'pending',
    temporaryKey: `pending/${randomUUID()}`,
    finalKey: null,
    rejectionReason: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    claimToken: null,
    claimExpiresAt: null,
    ...patch,
  })
  beforeAll(() => client.connect())
  afterEach(async () => {
    await client.query('DELETE FROM mail.outgoing_email WHERE user_id = ANY($1)', [
      [owner, foreignOwner],
    ])
    await client.query('DELETE FROM mail.attachment WHERE user_id = ANY($1)', [
      [owner, foreignOwner],
    ])
  })
  afterAll(async () => {
    await pool.end()
    await client.end()
  })

  it('persists empty attachment metadata without relaxing the upper size limit', async () => {
    expect(await repository.create(record({ size: 0 }))).toMatchObject({ size: 0 })
    await expect(repository.create(record({ size: -1 }))).rejects.toThrow()
    await expect(repository.create(record({ size: 10_000_001 }))).rejects.toThrow()
  })

  it('keeps metadata owner-scoped and only permits one unexpired completion lease', async () => {
    const row = await repository.create(record())
    expect(await repository.get(foreignOwner, row.id)).toBeNull()
    expect(await repository.claimCompletion(foreignOwner, row.id, 'wrong')).toBeNull()
    expect(await repository.claimCompletion(row.userId, row.id, 'first')).toMatchObject({
      claimToken: 'first',
    })
    expect(await repository.claimCompletion(row.userId, row.id, 'second')).toBeNull()
    expect(
      await repository.finishCompletion(row.userId, row.id, 'wrong', {
        status: 'clean',
        finalKey: finalKey('wrong'),
        rejectionReason: null,
      }),
    ).toBeNull()
  })

  it('recovers an expired completion lease and prevents stale publication or later mutation', async () => {
    const row = await repository.create(record())
    await repository.claimCompletion(row.userId, row.id, 'first')
    await client.query(
      "UPDATE mail.attachment SET claim_expires_at = now() - interval '1 second' WHERE id = $1",
      [row.id],
    )
    expect(
      await repository.finishCompletion(row.userId, row.id, 'first', {
        status: 'clean',
        finalKey: finalKey('stale'),
        rejectionReason: null,
      }),
    ).toBeNull()
    expect(await repository.claimCompletion(row.userId, row.id, 'second')).toBeTruthy()
    expect(
      await repository.finishCompletion(row.userId, row.id, 'first', {
        status: 'error',
        finalKey: null,
        rejectionReason: null,
      }),
    ).toBeNull()
    expect(
      await repository.finishCompletion(row.userId, row.id, 'second', {
        status: 'clean',
        finalKey: finalKey('clean'),
        rejectionReason: null,
      }),
    ).toMatchObject({ status: 'clean', finalKey: finalKey('clean'), claimToken: null })
    expect(await repository.claimCompletion(row.userId, row.id, 'third')).toBeNull()
    expect(await repository.isFinalKeyReferenced(finalKey('clean'))).toBe(true)
    expect(await repository.isFinalKeyReferenced(finalKey('missing'))).toBe(false)
  })

  it('claims expired unassociated objects, hides them, and deletes only with the current lease', async () => {
    const row = await repository.create(record({ expiresAt: new Date(Date.now() - 1_000) }))
    const claimed = await repository.claimExpired(100, 'cleanup')
    expect(claimed).toContainEqual(expect.objectContaining({ id: row.id, status: 'deleting' }))
    expect(await repository.get(row.userId, row.id)).toBeNull()
    expect(await repository.claimCompletion(row.userId, row.id, 'verify')).toBeNull()
    expect(await repository.deleteClaimed(row.userId, row.id, 'wrong')).toBe(false)
    expect(await repository.deleteClaimed(row.userId, row.id, 'cleanup')).toBe(true)
  })

  it('rechecks an association committed after the cleanup query snapshot before claiming its object', async () => {
    const row = await repository.create(
      record({
        status: 'clean',
        finalKey: finalKey('snapshot-race'),
        expiresAt: new Date(Date.now() - 1_000),
      }),
    )
    const gatedClient = new Client({ connectionString: databaseUrl })
    await gatedClient.connect()
    const [{ pid }] = (await gatedClient.query('SELECT pg_backend_pid() AS pid')).rows
    const originalQuery = gatedClient.query
    // Pause execution after PostgreSQL takes the candidate query's snapshot, before row locking.
    Object.defineProperty(gatedClient, 'query', {
      value: (query: { text?: string } | string, ...values: unknown[]) => {
        if (typeof query === 'object' && query.text?.includes('for update skip locked'))
          query = {
            ...query,
            text: query.text.replace(
              ' order by ',
              ' and (select true from pg_advisory_xact_lock(684203910)) order by ',
            ),
          }
        return Reflect.apply(originalQuery, gatedClient, [query, ...values])
      },
    })
    const gatedRepository = createAttachmentRepository(drizzle({ client: gatedClient }))
    await client.query('SELECT pg_advisory_lock(684203910)')
    await client.query('BEGIN')
    try {
      await client.query(
        'SELECT id FROM mail.attachment WHERE user_id = $1 AND id = $2 FOR UPDATE',
        [owner, row.id],
      )
      const messageId = randomUUID()
      await client.query(
        `INSERT INTO mail.outgoing_email (user_id, id, payload_hash, "to", cc, bcc, subject, html, text)
         VALUES ($1, $2, 'snapshot-race', '["ada@example.test"]', '[]', '[]', 'Hello', '<p>Hello</p>', 'Hello')`,
        [owner, messageId],
      )
      await client.query(
        `INSERT INTO mail.outgoing_email_attachment
         (user_id, message_id, attachment_id, position, filename, content_type, size, sha256, object_key)
         VALUES ($1, $2, $3, 0, 'hello.txt', 'text/plain', 5, $4, $5)`,
        [owner, messageId, row.id, row.sha256, row.finalKey],
      )
      const cleanup = gatedRepository.claimExpired(100, 'snapshot-cleanup')
      let blocked = false
      for (let attempt = 0; attempt < 100; attempt++) {
        const activity = await pool.query(
          'SELECT wait_event FROM pg_stat_activity WHERE pid = $1',
          [pid],
        )
        if (activity.rows[0]?.wait_event === 'advisory') {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await client.query('COMMIT')
      await client.query('SELECT pg_advisory_unlock(684203910)')
      const claimed = await cleanup
      expect(blocked).toBe(true)
      expect(claimed).not.toContainEqual(expect.objectContaining({ id: row.id }))
      expect(await repository.get(owner, row.id)).toMatchObject({ status: 'clean' })
      expect(await repository.isAssociated(owner, row.id)).toBe(true)
    } finally {
      await client.query('ROLLBACK')
      await client.query('SELECT pg_advisory_unlock_all()')
      await gatedClient.end()
    }
  })

  it('binds immutable clean attachments atomically before sending and protects them from cleanup', async () => {
    const row = await repository.create(
      record({
        status: 'clean',
        finalKey: finalKey('bound'),
        rejectionReason: null,
      }),
    )
    expect(await repository.isAssociated(row.userId, row.id)).toBe(false)
    const input = {
      userId: row.userId,
      id: randomUUID(),
      payloadHash: 'bound',
      to: ['ada@example.test'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      attachments: [{ id: row.id }],
    }
    await outgoing.reserve(input)
    expect(await repository.isAssociated(row.userId, row.id)).toBe(true)
    expect(await repository.isAssociated(foreignOwner, row.id)).toBe(false)
    await client.query(
      "UPDATE mail.attachment SET expires_at = now() - interval '1 second' WHERE id = $1",
      [row.id],
    )
    expect(await repository.claimExpired(100, 'cleanup')).not.toContainEqual(
      expect.objectContaining({ id: row.id }),
    )
    await outgoing.markSent(row.userId, input.id, 'provider')
    const [message] = await outgoing.listSent(row.userId, 0)
    expect(message?.attachments).toContainEqual(
      expect.objectContaining({ id: row.id, filename: 'hello.txt', size: 5 }),
    )
    expect(message?.attachments?.[0]).not.toHaveProperty('objectKey')
    expect(await outgoing.findSent?.(foreignOwner, input.id)).toBeNull()
    expect(await outgoing.findSent?.(row.userId, input.id)).toMatchObject({ html: '<p>Hello</p>' })
    expect(await outgoing.reserve(input)).toMatchObject({ payloadHash: 'bound' })
  })

  it('rolls back a reservation when an attachment is pending, expired, foreign or duplicated', async () => {
    const rows = [
      await repository.create(record()),
      await repository.create(
        record({
          userId: foreignOwner,
          status: 'clean',
          finalKey: finalKey('other'),
          rejectionReason: null,
        }),
      ),
      await repository.create(
        record({
          status: 'clean',
          finalKey: finalKey('expired'),
          rejectionReason: null,
          expiresAt: new Date(Date.now() - 1_000),
        }),
      ),
      await repository.create(
        record({
          status: 'clean',
          finalKey: finalKey('duplicate'),
          rejectionReason: null,
        }),
      ),
    ]
    for (const [index, row] of rows.entries()) {
      const references = index === 3 ? [{ id: row.id }, { id: row.id }] : [{ id: row.id }]
      const id = randomUUID()
      await expect(
        outgoing.reserve({
          userId: owner,
          id,
          payloadHash: 'invalid',
          to: ['ada@example.test'],
          cc: [],
          bcc: [],
          subject: 'Hello',
          html: '<p>Hello</p>',
          text: 'Hello',
          attachments: references,
        }),
      ).rejects.toThrow()
      expect(
        (await client.query('SELECT id FROM mail.outgoing_email WHERE id = $1', [id])).rows,
      ).toEqual([])
    }
  })
  it('caps active unassociated uploads per owner even for concurrent initiation', async () => {
    await database.insert(attachments).values(Array.from({ length: 99 }, () => record()))
    const attempts = await Promise.allSettled([
      repository.create(record()),
      repository.create(record()),
    ])
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(
      (
        await client.query(
          'SELECT count(*)::int AS count FROM mail.attachment WHERE user_id = $1',
          [owner],
        )
      ).rows,
    ).toEqual([{ count: 100 }])
  })
  it('serializes concurrent identical reservations into one immutable attachment snapshot', async () => {
    const row = await repository.create(
      record({
        status: 'clean',
        finalKey: finalKey('concurrent'),
      }),
    )
    const input = {
      userId: owner,
      id: randomUUID(),
      payloadHash: 'same',
      to: ['ada@example.test'],
      cc: [],
      bcc: [],
      subject: 'Concurrent',
      html: '<p>Hello</p>',
      text: 'Hello',
      attachments: [{ id: row.id, contentId: 'inline-1' }],
    }
    const attempts = await Promise.all([outgoing.reserve(input), outgoing.reserve(input)])
    expect(attempts.map(({ id }) => id)).toEqual([input.id, input.id])
    expect(
      (
        await client.query(
          'SELECT count(*)::int AS count FROM mail.outgoing_email_attachment WHERE user_id = $1 AND message_id = $2',
          [owner, input.id],
        )
      ).rows,
    ).toEqual([{ count: 1 }])
  })

  it('reclaims a stale cleanup lease without allowing its previous owner to delete the record', async () => {
    const row = await repository.create(record({ expiresAt: new Date(Date.now() - 1_000) }))
    await repository.claimExpired(100, 'old-cleanup')
    await client.query(
      "UPDATE mail.attachment SET claim_expires_at = now() - interval '1 second' WHERE user_id = $1 AND id = $2",
      [owner, row.id],
    )
    expect(await repository.claimExpired(100, 'new-cleanup')).toContainEqual(
      expect.objectContaining({ id: row.id, claimToken: 'new-cleanup' }),
    )
    expect(await repository.deleteClaimed(owner, row.id, 'old-cleanup')).toBe(false)
    expect(await repository.deleteClaimed(owner, row.id, 'new-cleanup')).toBe(true)
  })
})
