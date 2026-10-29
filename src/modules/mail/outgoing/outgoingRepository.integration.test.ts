import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Client, Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createOutgoingRepository } from '../infrastructure/database/outgoingRepository.js'
import { sendEmail } from './sendEmail.js'
import { ProviderRejectedError } from './types.js'

const databaseUrl = process.env.MAILFLOW_MAIL_INTEGRATION_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
integration('outgoing mail PostgreSQL persistence', () => {
  const client = new Client({ connectionString: databaseUrl ?? 'postgresql://localhost/invalid' })
  const pool = new Pool({ connectionString: databaseUrl ?? 'postgresql://localhost/invalid' })
  const repository = createOutgoingRepository(drizzle({ client: pool }))
  const owner = `outgoing-persistence-${randomUUID()}`
  const pending = `outgoing-pending-${randomUUID()}`
  const other = `outgoing-other-${randomUUID()}`
  const context = (userId = owner, workspaceId = 'workspace-a') => ({ userId, workspaceId })
  const input = {
    workspaceId: 'workspace-a',
    deliveryKey: 'test-delivery-key',
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
    await sendEmail({ repository, deliver: async () => 'provider-id' }, context(owner), input)
    expect(await repository.listSent(context(other), 0)).toEqual([])
    expect(await repository.listSent(context(pending), 0)).toEqual([])
    expect(await repository.listSent(context(), 0)).toEqual([
      expect.objectContaining({
        id: input.id,
        to: input.to,
        bcc: input.bcc,
        sentAt: expect.any(Date),
      }),
    ])
  })
  it('does not claim a sender when an uncertain delivery is retried with a changed sender', async () => {
    const initial = {
      repository,
      senderEmail: 'old@example.test',
      deliver: async () => {
        throw new Error('delivery uncertain')
      },
    }
    await expect(sendEmail(initial, context(), input)).rejects.toThrow('delivery uncertain')
    await sendEmail(
      { repository, senderEmail: 'new@example.test', deliver: async () => 'provider-id' },
      context(),
      input,
    )
    expect(await repository.findSent?.(context(), input.id)).toMatchObject({ senderEmail: null })
  })

  it('retains the sender for uncertain retries when configuration did not change', async () => {
    await expect(
      sendEmail(
        {
          repository,
          senderEmail: 'same@example.test',
          deliver: async () => {
            throw new Error('delivery uncertain')
          },
        },
        context(),
        input,
      ),
    ).rejects.toThrow('delivery uncertain')
    await sendEmail(
      { repository, senderEmail: 'same@example.test', deliver: async () => 'provider-id' },
      context(),
      input,
    )
    expect(await repository.findSent?.(context(), input.id)).toMatchObject({
      senderEmail: 'same@example.test',
    })
  })
  it('records the new sender after a definitively rejected attempt', async () => {
    await expect(
      sendEmail(
        {
          repository,
          senderEmail: 'old@example.test',
          deliver: async () => {
            throw new ProviderRejectedError('rejected')
          },
        },
        context(),
        input,
      ),
    ).rejects.toThrow('rejected')
    await sendEmail(
      { repository, senderEmail: 'new@example.test', deliver: async () => 'provider-id' },
      context(),
      input,
    )
    expect(await repository.findSent?.(context(), input.id)).toMatchObject({
      senderEmail: 'new@example.test',
    })
  })

  it('rejects cross-workspace retries and lists only the selected workspace', async () => {
    const dependencies = { repository, deliver: async () => 'provider-id' }
    await sendEmail(dependencies, context(), input)
    await expect(sendEmail(dependencies, context(owner, 'workspace-b'), input)).rejects.toThrow(
      'another workspace',
    )
    await repository.markSent(context(owner, 'workspace-b'), input.id, 'wrong-provider')
    expect(
      (await repository.reserve({ ...input, ...context(), payloadHash: 'ignored' })).providerId,
    ).toBe('provider-id')
    await sendEmail(dependencies, context(owner, 'workspace-b'), { ...input, id: randomUUID() })
    expect(await repository.listSent(context(), 0)).toHaveLength(1)
    expect(await repository.listSent(context(owner, 'workspace-b'), 0)).toHaveLength(1)
    expect(await repository.findSent?.(context(owner, 'workspace-b'), input.id)).toBeNull()
  })
  it('isolates confirmed Sent messages by both owner and selected workspace', async () => {
    const dependencies = { repository, deliver: async () => 'provider' }
    const alpha = { ...input, id: randomUUID(), subject: 'Alpha' }
    const beta = { ...input, id: randomUUID(), subject: 'Beta' }
    await sendEmail(dependencies, context(), alpha)
    await sendEmail(dependencies, context(owner, 'workspace-b'), beta)
    await sendEmail(dependencies, context(other), {
      ...input,
      id: randomUUID(),
      subject: 'Foreign owner',
    })
    await repository.reserve({ ...input, id: randomUUID(), userId: owner, payloadHash: 'pending' })
    expect((await repository.listSent(context(), 0)).map(({ id }) => id)).toEqual([alpha.id])
    expect(
      (await repository.listSent(context(owner, 'workspace-b'), 0)).map(({ id }) => id),
    ).toEqual([beta.id])
    expect(await repository.listSent(context(owner, 'workspace-c'), 0)).toEqual([])
    await expect(repository.listSent({ userId: owner, workspaceId: '' }, 0)).rejects.toThrow()
  })
  it('paginates within the selected workspace instead of mixing messages before offset', async () => {
    const dependencies = { repository, deliver: async () => 'provider' }
    for (let index = 0; index < 23; index++) {
      const id = randomUUID()
      await sendEmail(dependencies, context(owner, index % 2 ? 'workspace-b' : 'workspace-a'), {
        ...input,
        id,
      })
      await client.query('UPDATE mail.outgoing_email SET sent_at=$1 WHERE user_id=$2 AND id=$3', [
        new Date(1_700_000_000_000 + index),
        owner,
        id,
      ])
    }
    const all = await repository.listSent(context(), 0)
    const page = await repository.listSent(context(), 5)
    expect(all).toHaveLength(12)
    expect(page.map(({ id }) => id)).toEqual(all.slice(5).map(({ id }) => id))
    expect(await repository.listSent(context(owner, 'workspace-b'), 0)).toHaveLength(11)
  })
  it('reserves atomically, preserves the original content and rejects conflicting retries', async () => {
    await repository.reserve({ ...input, userId: owner, payloadHash: 'original' })
    const reserved = await repository.reserve({
      ...input,
      subject: 'Changed',
      userId: owner,
      workspaceId: 'workspace-a',
      deliveryKey: 'test-delivery-key',
      payloadHash: 'different',
    })
    expect(reserved.payloadHash).toBe('original')
    await expect(
      sendEmail({ repository, deliver: async () => 'provider-id' }, context(owner), input),
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
    await sendEmail(dependencies, context(owner), input)
    await sendEmail(dependencies, context(owner), input)
    expect(deliveries).toBe(1)
    for (let index = 2; index <= 22; index++) {
      await sendEmail(dependencies, context(owner), {
        ...input,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      })
    }
    const first = await repository.listSent(context(), 0)
    const second = await repository.listSent(context(), 20)
    expect(first).toHaveLength(21)
    expect(second).toHaveLength(2)
    expect(new Set([...first.slice(0, 20), ...second].map(({ id }) => id)).size).toBe(22)
  })
  it('persists the optional recipient name in Sent and keeps legacy unnamed sends valid', async () => {
    const dependencies = { repository, deliver: async () => 'provider-id' }
    await sendEmail(dependencies, context(owner), { ...input, recipientName: 'Ada Lovelace' })
    expect(await repository.listSent(context(), 0)).toEqual([
      expect.objectContaining({ recipientName: 'Ada Lovelace', to: input.to }),
    ])
    await sendEmail(dependencies, context(owner), {
      ...input,
      id: '00000000-0000-4000-8000-000000000002',
    })
    expect(await repository.listSent(context(), 0)).toContainEqual(
      expect.objectContaining({ recipientName: '' }),
    )
  })
})
