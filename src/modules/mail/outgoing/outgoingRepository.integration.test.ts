import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Client, Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createOutgoingRepository } from '../infrastructure/database/outgoingRepository.js'
import { createLabelRepository } from '../labels/repository.js'
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
  it('includes persisted labels in Sent list and detail for the message owner', async () => {
    await sendEmail({ repository, deliver: async () => 'provider-id' }, context(), input)
    const labels = createLabelRepository(pool)
    const label = await labels.createLabel(context().workspaceId, `Sent-${randomUUID()}`)
    if (!label) throw new Error('Expected fixture label')
    try {
      await labels.changeMessageLabel(
        context().workspaceId,
        owner,
        'sent',
        input.id,
        label.id,
        true,
      )
      expect(await repository.listSent(context(), 0)).toMatchObject([
        { id: input.id, labels: [label] },
      ])
      expect(await repository.findSent?.(context(), input.id)).toMatchObject({ labels: [label] })
      expect(await repository.findSent?.(context(other), input.id)).toBeNull()
    } finally {
      await client.query('DELETE FROM mail.label WHERE workspace_id=$1 AND id=$2', [
        context().workspaceId,
        label.id,
      ])
    }
  })
  it('searches recipients, subject, body and label names literally for the owner only', async () => {
    const send = (
      id: string,
      extra: {
        to?: string[]
        cc?: string[]
        bcc?: string[]
        subject?: string
        text?: string
        html?: string
      },
    ) => {
      const message = { ...input, id, deliveryKey: `key-${id}`, ...extra }
      return sendEmail({ repository, deliver: async () => `provider-${id}` }, context(), message)
    }
    const byRecipient = randomUUID()
    const byCc = randomUUID()
    const bySubject = randomUUID()
    const byBody = randomUUID()
    const byLabel = randomUUID()
    await send(byRecipient, { to: ['ada.lovelace@example.test'], bcc: [] })
    await send(byCc, { cc: ['grace@navy.test'], bcc: [] })
    await send(bySubject, { subject: 'Invoice 100%_final' })
    await send(byBody, { text: 'Please review the ATTACHED contract', html: '<p>x</p>' })
    await send(byLabel, {})
    const labels = createLabelRepository(pool)
    const label = await labels.createLabel(context().workspaceId, `Budget-${randomUUID()}`)
    if (!label) throw new Error('Expected fixture label')
    try {
      await labels.changeMessageLabel(context().workspaceId, owner, 'sent', byLabel, label.id, true)
      const ids = async (search: string, user = owner) =>
        (await repository.listSent(context(user), 0, search)).map(({ id }) => id).sort()
      expect(await ids('')).toHaveLength(5)
      expect(await ids('LOVELACE')).toEqual([byRecipient])
      expect(await ids('navy.test')).toEqual([byCc])
      expect(await ids('invoice')).toEqual([bySubject])
      expect(await ids('%')).toEqual([bySubject])
      expect(await ids('attached contract')).toEqual([byBody])
      expect(await ids(label.name.toLowerCase())).toEqual([byLabel])
      expect(await ids('no such text')).toEqual([])
      expect(await ids('invoice', other)).toEqual([])
    } finally {
      await client.query('DELETE FROM mail.label WHERE workspace_id=$1 AND id=$2', [
        context().workspaceId,
        label.id,
      ])
    }
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
  it('orders Sent by date, displayed correspondent and subject with an id tie-break across pages', async () => {
    const dependencies = { repository, deliver: async () => 'provider' }
    // Recipient names fall back to the first To address, so "alpha" ties a named and an unnamed send.
    const correspondents = [
      { recipientName: 'Beta', to: ['zulu@example.test'] },
      { recipientName: '  ', to: ['alpha@example.test'] },
      { recipientName: 'alpha@example.test', to: ['yankee@example.test'] },
      { recipientName: 'Gamma', to: ['xray@example.test'] },
    ]
    const subjects = ['Eta', 'zeta', 'ETA', 'theta', 'Zeta']
    const sent = Array.from({ length: 23 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(((index * 5) % 23) + 1).padStart(12, '0')}`,
      ...(correspondents[index % correspondents.length] as (typeof correspondents)[number]),
      subject: subjects[index % subjects.length] ?? '',
      sentAt: new Date(1_700_000_000_000 + Math.floor(index / 3) * 1000),
    }))
    for (const { sentAt, ...message } of sent) {
      await sendEmail(dependencies, context(), { ...input, ...message, bcc: [] })
      await client.query('UPDATE mail.outgoing_email SET sent_at=$1 WHERE user_id=$2 AND id=$3', [
        sentAt,
        owner,
        message.id,
      ])
    }
    const correspondent = (message: (typeof sent)[number]) =>
      (message.recipientName.trim() || message.to[0] || '').toLowerCase()
    const keyOf = {
      newest: (message: (typeof sent)[number]) => message.sentAt.getTime(),
      oldest: (message: (typeof sent)[number]) => message.sentAt.getTime(),
      'sender-asc': correspondent,
      'sender-desc': correspondent,
      'subject-asc': (message: (typeof sent)[number]) => message.subject.toLowerCase(),
      'subject-desc': (message: (typeof sent)[number]) => message.subject.toLowerCase(),
    } as const
    const compare = (left: string | number, right: string | number) =>
      left < right ? -1 : left > right ? 1 : 0
    for (const sort of Object.keys(keyOf) as (keyof typeof keyOf)[]) {
      const sign = sort === 'newest' || sort.endsWith('-desc') ? -1 : 1
      const expected = [...sent]
        .sort(
          (left, right) =>
            sign * (compare(keyOf[sort](left), keyOf[sort](right)) || compare(left.id, right.id)),
        )
        .map(({ id }) => id)
      const first = await repository.listSent(context(), 0, '', sort)
      const second = await repository.listSent(context(), 20, '', sort)
      expect(first).toHaveLength(21)
      expect([...first.slice(0, 20), ...second].map(({ id }) => id)).toEqual(expected)
    }
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
