import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Client, Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createOutgoingRepository } from '../infrastructure/database/outgoingRepository.js'
import { sendEmail } from './sendEmail.js'

const databaseUrl = process.env.MAILFLOW_MAIL_INTEGRATION_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
integration('outgoing mail PostgreSQL persistence', () => {
  const client = new Client({ connectionString: databaseUrl ?? 'postgresql://localhost/invalid' })
  const pool = new Pool({ connectionString: databaseUrl ?? 'postgresql://localhost/invalid' })
  const repository = createOutgoingRepository(drizzle({ client: pool }))
  const owner = `outgoing-persistence-${randomUUID()}`
  const pending = `outgoing-pending-${randomUUID()}`
  const other = `outgoing-other-${randomUUID()}`
  const input = {
    id: '00000000-0000-4000-8000-000000000001',
    to: ['ada@example.test'],
    cc: [],
    bcc: ['hidden@example.test'],
    subject: 'Hello',
    html: '<p>Hello</p>',
    text: 'Hello',
    attachments: [],
  }
  beforeAll(() => client.connect())
  beforeEach(async () => {
    await client.query('DELETE FROM mail.outgoing_email WHERE user_id = ANY($1)', [
      [owner, pending, other],
    ])
  })
  afterEach(() =>
    client.query('DELETE FROM mail.outgoing_email WHERE user_id = ANY($1)', [
      [owner, pending, other],
    ]),
  )
  afterAll(async () => {
    await pool.end()
    await client.end()
  })
  it('lists only confirmed messages owned by the authenticated user', async () => {
    await repository.reserve({ ...input, userId: pending, payloadHash: pending })
    await sendEmail({ repository, deliver: async () => 'provider-id' }, owner, input)
    expect(await repository.listSent(other, 0)).toEqual([])
    expect(await repository.listSent(pending, 0)).toEqual([])
    expect(await repository.listSent(owner, 0)).toEqual([
      expect.objectContaining({
        id: input.id,
        to: input.to,
        bcc: input.bcc,
        sentAt: expect.any(Date),
      }),
    ])
  })
  it('reserves atomically, preserves the original content and rejects conflicting retries', async () => {
    await repository.reserve({ ...input, userId: owner, payloadHash: 'original' })
    const reserved = await repository.reserve({
      ...input,
      subject: 'Changed',
      userId: owner,
      payloadHash: 'different',
    })
    expect(reserved.payloadHash).toBe('original')
    await expect(
      sendEmail({ repository, deliver: async () => 'provider-id' }, owner, input),
    ).rejects.toThrow('different message')
  })
  it('persists one sent copy when retrying and paginates in deterministic order', async () => {
    let deliveries = 0
    const dependencies = {
      repository,
      deliver: async () => {
        deliveries++
        return 'provider-id'
      },
    }
    await sendEmail(dependencies, owner, input)
    await sendEmail(dependencies, owner, input)
    expect(deliveries).toBe(1)
    for (let index = 2; index <= 22; index++) {
      await sendEmail(dependencies, owner, {
        ...input,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      })
    }
    const first = await repository.listSent(owner, 0)
    const second = await repository.listSent(owner, 20)
    expect(first).toHaveLength(21)
    expect(second).toHaveLength(2)
    expect(new Set([...first.slice(0, 20), ...second].map(({ id }) => id)).size).toBe(22)
  })
  it('persists the optional recipient name in Sent and keeps legacy unnamed sends valid', async () => {
    const dependencies = { repository, deliver: async () => 'provider-id' }
    await sendEmail(dependencies, owner, { ...input, recipientName: 'Ada Lovelace' })
    expect(await repository.listSent(owner, 0)).toEqual([
      expect.objectContaining({ recipientName: 'Ada Lovelace', to: input.to }),
    ])
    await sendEmail(dependencies, owner, { ...input, id: '00000000-0000-4000-8000-000000000002' })
    expect(await repository.listSent(owner, 0)).toContainEqual(
      expect.objectContaining({ recipientName: '' }),
    )
  })
})
