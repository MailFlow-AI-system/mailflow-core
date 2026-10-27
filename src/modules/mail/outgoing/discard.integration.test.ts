import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAttachmentRepository } from '../infrastructure/database/attachmentRepository.js'
import { createOutgoingRepository } from '../infrastructure/database/outgoingRepository.js'
import { sendEmail } from './sendEmail.js'
import { ProviderRejectedError } from './types.js'

const databaseUrl = process.env.MAILFLOW_MAIL_INTEGRATION_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
integration('safe outgoing discard PostgreSQL', () => {
  const pool = new Pool({ connectionString: databaseUrl })
  const client = new Client({ connectionString: databaseUrl })
  const database = drizzle({ client: pool })
  const repository = createOutgoingRepository(database)
  const files = createAttachmentRepository(database)
  const userId = `discard-${randomUUID()}`
  const context = { userId, workspaceId: 'workspace-a' }
  const input = (id = randomUUID()) => ({
    id,
    to: ['ada@example.test'],
    cc: [],
    bcc: [],
    subject: 'Hello',
    html: '<p>Hello</p>',
    text: 'Hello',
    attachments: [],
  })
  async function file() {
    const id = randomUUID()
    return files.create({
      ...context,
      id,
      filename: 'check.txt',
      contentType: 'text/plain',
      size: 5,
      sha256: 'a'.repeat(64),
      temporaryKey: `uploads/${userId}/${id}`,
      finalKey: `workspaces/workspace-a/mail/attachments/${id}/${randomUUID()}`,
      status: 'clean',
      rejectionReason: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      claimToken: null,
      claimExpiresAt: null,
    })
  }
  beforeAll(() => client.connect())
  afterAll(async () => {
    await client.query('DELETE FROM mail.outgoing_email WHERE user_id=$1', [userId])
    await client.query('DELETE FROM mail.attachment WHERE user_id=$1', [userId])
    await client.end()
    await pool.end()
  })
  it('expires abandoned safe reservations while retaining uncertain and accepted files', async () => {
    const cases: { id: string; fileId: string; protected: boolean }[] = []
    for (const state of ['ready', 'rejected', 'uncertain', 'sent'] as const) {
      const attachment = await file()
      const message = { ...input(), attachments: [{ id: attachment.id }] }
      await repository.reserve({ ...message, ...context, payloadHash: state, deliveryKey: state })
      await client.query(
        "UPDATE mail.outgoing_email SET created_at=now()-interval '25 hours', delivery_state=$3, provider_id=$4 WHERE user_id=$1 AND id=$2",
        [userId, message.id, state, state === 'sent' ? 'provider' : null],
      )
      cases.push({
        id: message.id,
        fileId: attachment.id,
        protected: state === 'uncertain' || state === 'sent',
      })
    }
    expect(await repository.cleanupAbandoned()).toBeGreaterThanOrEqual(2)
    for (const record of cases)
      expect(await files.isAssociated(context, record.fileId)).toBe(record.protected)
  })
  it('retains old writers whose inserts omit lifecycle tracking', async () => {
    const message = input()
    await client.query(
      'INSERT INTO mail.outgoing_email(id,user_id,workspace_id,payload_hash,"to",cc,bcc,subject,html,text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        message.id,
        userId,
        context.workspaceId,
        'legacy',
        JSON.stringify(message.to),
        '[]',
        '[]',
        message.subject,
        message.html,
        message.text,
      ],
    )
    expect(
      (await repository.discard(context, { messageIds: [message.id], attachmentIds: [] }))
        .retainedMessageIds,
    ).toEqual([message.id])
  })
  it('tombstones a discarded unseen id so a delayed send cannot deliver', async () => {
    const message = input()
    expect(
      await repository.discard(context, { messageIds: [message.id], attachmentIds: [] }),
    ).toEqual({ status: 'discarded', retainedMessageIds: [] })
    const deliver = vi.fn(async () => 'provider')
    await expect(sendEmail({ repository, deliver }, context, message)).rejects.toThrow('discarded')
    expect(deliver).not.toHaveBeenCalled()
  })
  it('releases only safely rejected message files and keeps the cancellation idempotent', async () => {
    const attachment = await file()
    const message = { ...input(), attachments: [{ id: attachment.id }] }
    await expect(
      sendEmail(
        {
          repository,
          deliver: async () => {
            throw new ProviderRejectedError('rejected')
          },
          resolveAttachments: async () => [],
        },
        context,
        message,
      ),
    ).rejects.toThrow('rejected')
    const request = { messageIds: [message.id], attachmentIds: [attachment.id] }
    expect((await repository.discard(context, request)).retainedMessageIds).toEqual([])
    expect((await repository.discard(context, request)).retainedMessageIds).toEqual([])
    expect(await files.isAssociated(context, attachment.id)).toBe(false)
    expect((await files.get(context, attachment.id))?.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now(),
    )
  })
  it('retains timed-out, historical-uncertain and accepted message files', async () => {
    for (const result of ['timeout', 'accepted', 'historical'] as const) {
      const attachment = await file()
      const message = { ...input(), attachments: [{ id: attachment.id }] }
      if (result === 'historical') {
        await repository.reserve({
          ...message,
          ...context,
          payloadHash: 'historical',
          deliveryKey: 'historical',
        })
        await client.query(
          "UPDATE mail.outgoing_email SET delivery_state='uncertain' WHERE user_id=$1 AND id=$2",
          [userId, message.id],
        )
      } else {
        await sendEmail(
          {
            repository,
            deliver: async () => {
              if (result === 'timeout') throw new Error('timeout')
              return 'accepted-provider'
            },
            resolveAttachments: async () => [],
          },
          context,
          message,
        ).catch(() => {})
      }
      expect(
        (
          await repository.discard(context, {
            messageIds: [message.id],
            attachmentIds: [attachment.id],
          })
        ).retainedMessageIds,
      ).toEqual([message.id])
      expect(await files.isAssociated(context, attachment.id)).toBe(true)
      expect((await files.get(context, attachment.id))?.expiresAt.getTime()).toBeGreaterThan(
        Date.now(),
      )
    }
  })
  it('does not downgrade a prior uncertainty or an accepted outcome after a later rejection', async () => {
    const message = input()
    await repository.reserve({
      ...message,
      ...context,
      payloadHash: 'original',
      deliveryKey: 'key',
    })
    const first = await repository.beginAttempt(context, message.id)
    const second = await repository.beginAttempt(context, message.id)
    if (!first || !second) throw new Error('attempt unavailable')
    await repository.markRejected(context, message.id, first)
    await repository.markRejected(context, message.id, second)
    expect(
      (await repository.discard(context, { messageIds: [message.id], attachmentIds: [] }))
        .retainedMessageIds,
    ).toEqual([message.id])
    await repository.markSent(context, message.id, 'accepted')
    await repository.markRejected(context, message.id, first)
    expect((await repository.findSent?.(context, message.id))?.id).toBe(message.id)
  })
  it('keeps files shared with accepted messages and isolates owner/workspace cancellation', async () => {
    const attachment = await file()
    const accepted = { ...input(), attachments: [{ id: attachment.id }] }
    const ready = { ...input(), attachments: [{ id: attachment.id }] }
    await sendEmail(
      { repository, deliver: async () => 'accepted', resolveAttachments: async () => [] },
      context,
      accepted,
    )
    await repository.reserve({ ...ready, ...context, payloadHash: 'ready', deliveryKey: 'ready' })
    await repository.discard(
      { ...context, workspaceId: 'workspace-b' },
      { messageIds: [accepted.id], attachmentIds: [attachment.id] },
    )
    await repository.discard(
      { ...context, userId: `${userId}-foreign` },
      { messageIds: [accepted.id], attachmentIds: [attachment.id] },
    )
    await repository.discard(context, { messageIds: [ready.id], attachmentIds: [attachment.id] })
    expect(await files.isAssociated(context, attachment.id)).toBe(true)
    expect((await files.get(context, attachment.id))?.expiresAt.getTime()).toBeGreaterThan(
      Date.now(),
    )
    await client.query('DELETE FROM mail.outgoing_email WHERE user_id=$1', [`${userId}-foreign`])
  })
  it('lets cancellation win while attachment bytes are still being resolved', async () => {
    const attachment = await file()
    const message = { ...input(), attachments: [{ id: attachment.id }] }
    let resolving!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => {
      resolving = resolve
    })
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const deliver = vi.fn(async () => 'provider')
    const sending = sendEmail(
      {
        repository,
        deliver,
        resolveAttachments: async () => {
          resolving()
          await paused
          return []
        },
      },
      context,
      message,
    )
    await reached
    await repository.discard(context, { messageIds: [message.id], attachmentIds: [attachment.id] })
    release()
    await expect(sending).rejects.toThrow('discarded')
    expect(deliver).not.toHaveBeenCalled()
    expect(await files.isAssociated(context, attachment.id)).toBe(false)
  })
  it('retains files if the provider accepts but persisting Sent fails', async () => {
    const attachment = await file()
    const message = { ...input(), attachments: [{ id: attachment.id }] }
    await expect(
      sendEmail(
        {
          repository: {
            ...repository,
            markSent: async () => {
              throw new Error('database unavailable')
            },
          },
          deliver: async () => 'accepted',
          resolveAttachments: async () => [],
        },
        context,
        message,
      ),
    ).rejects.toThrow('database unavailable')
    expect(
      (
        await repository.discard(context, {
          messageIds: [message.id],
          attachmentIds: [attachment.id],
        })
      ).retainedMessageIds,
    ).toEqual([message.id])
    expect(await files.isAssociated(context, attachment.id)).toBe(true)
  })
  it('serializes a provider attempt against cancellation and protects in-flight files', async () => {
    const attachment = await file()
    const message = { ...input(), attachments: [{ id: attachment.id }] }
    let providerReached!: () => void
    let accept!: (providerId: string) => void
    const reached = new Promise<void>((resolve) => {
      providerReached = resolve
    })
    const provider = new Promise<string>((resolve) => {
      accept = resolve
    })
    const sending = sendEmail(
      {
        repository,
        resolveAttachments: async () => [],
        deliver: async () => {
          providerReached()
          return provider
        },
      },
      context,
      message,
    )
    await reached
    expect(
      (
        await repository.discard(context, {
          messageIds: [message.id],
          attachmentIds: [attachment.id],
        })
      ).retainedMessageIds,
    ).toEqual([message.id])
    expect(await files.isAssociated(context, attachment.id)).toBe(true)
    accept('accepted')
    expect(await sending).toEqual({ id: message.id, status: 'sent' })
  })
})
