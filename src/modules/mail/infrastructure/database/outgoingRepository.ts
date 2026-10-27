import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { assertMailContext } from '../../context/types.js'
import {
  MessageConflictError,
  type OutgoingRepository,
  type SentAttachment,
} from '../../outgoing/types.js'
import { attachments, outgoingEmailAttachments } from './schema/attachments.js'
import { outgoingEmails } from './schema/outgoingEmails.js'

export function createOutgoingRepository(database: NodePgDatabase): OutgoingRepository {
  const sentSelection = {
    id: outgoingEmails.id,
    to: outgoingEmails.to,
    cc: outgoingEmails.cc,
    bcc: outgoingEmails.bcc,
    recipientName: outgoingEmails.recipientName,
    subject: outgoingEmails.subject,
    text: outgoingEmails.text,
    sentAt: outgoingEmails.sentAt,
  }
  async function sentAttachments(userId: string, messageIds: string[]) {
    const byMessage = new Map<string, SentAttachment[]>()
    if (!messageIds.length) return byMessage
    const rows = await database
      .select({
        messageId: outgoingEmailAttachments.messageId,
        id: outgoingEmailAttachments.attachmentId,
        filename: outgoingEmailAttachments.filename,
        contentType: outgoingEmailAttachments.contentType,
        size: outgoingEmailAttachments.size,
        sha256: outgoingEmailAttachments.sha256,
        contentId: outgoingEmailAttachments.contentId,
      })
      .from(outgoingEmailAttachments)
      .where(
        and(
          eq(outgoingEmailAttachments.userId, userId),
          inArray(outgoingEmailAttachments.messageId, messageIds),
        ),
      )
      .orderBy(asc(outgoingEmailAttachments.position))
    for (const { messageId, ...metadata } of rows) {
      const current = byMessage.get(messageId) ?? []
      current.push(metadata)
      byMessage.set(messageId, current)
    }
    return byMessage
  }
  const discard: OutgoingRepository['discard'] = async (context, request) => {
    assertMailContext(context)
    if (request.messageIds.length > 100 || request.attachmentIds.length > 100)
      throw new Error('Discard batch is too large')
    return database.transaction(async (transaction) => {
      const messageIds = [...new Set(request.messageIds)].sort()
      const attachmentIds = new Set(request.attachmentIds)
      const retainedMessageIds: string[] = []
      if (messageIds.length) {
        // Tombstones also cover a delayed send whose reservation has not reached Core yet.
        await transaction
          .insert(outgoingEmails)
          .values(
            messageIds.map((id) => ({
              ...context,
              id,
              payloadHash: 'discarded',
              to: [],
              cc: [],
              bcc: [],
              subject: '',
              html: '',
              text: '',
              deliveryState: 'discarded' as const,
            })),
          )
          .onConflictDoNothing()
        const rows = await transaction
          .select()
          .from(outgoingEmails)
          .where(
            and(
              eq(outgoingEmails.userId, context.userId),
              eq(outgoingEmails.workspaceId, context.workspaceId),
              inArray(outgoingEmails.id, messageIds),
            ),
          )
          .orderBy(asc(outgoingEmails.id))
          .for('update')
        const safeIds: string[] = []
        for (const row of rows) {
          if (row.providerId || !['ready', 'rejected', 'discarded'].includes(row.deliveryState))
            retainedMessageIds.push(row.id)
          else safeIds.push(row.id)
        }
        if (safeIds.length) {
          await transaction
            .update(outgoingEmails)
            .set({ deliveryState: 'discarded', attemptToken: null, payloadHash: 'discarded' })
            .where(
              and(
                eq(outgoingEmails.userId, context.userId),
                eq(outgoingEmails.workspaceId, context.workspaceId),
                inArray(outgoingEmails.id, safeIds),
              ),
            )
          const removed = await transaction
            .delete(outgoingEmailAttachments)
            .where(
              and(
                eq(outgoingEmailAttachments.userId, context.userId),
                eq(outgoingEmailAttachments.workspaceId, context.workspaceId),
                inArray(outgoingEmailAttachments.messageId, safeIds),
              ),
            )
            .returning({ id: outgoingEmailAttachments.attachmentId })
          for (const row of removed) attachmentIds.add(row.id)
        }
      }
      if (attachmentIds.size) {
        const ids = [...attachmentIds].sort()
        const rows = await transaction
          .select({ id: attachments.id })
          .from(attachments)
          .where(
            and(
              eq(attachments.userId, context.userId),
              eq(attachments.workspaceId, context.workspaceId),
              inArray(attachments.id, ids),
            ),
          )
          .orderBy(asc(attachments.id))
          .for('update')
        if (rows.length) {
          // Read again after acquiring file locks so a concurrently committed association is protected.
          const associated = await transaction
            .select({ id: outgoingEmailAttachments.attachmentId })
            .from(outgoingEmailAttachments)
            .where(
              and(
                eq(outgoingEmailAttachments.userId, context.userId),
                eq(outgoingEmailAttachments.workspaceId, context.workspaceId),
                inArray(
                  outgoingEmailAttachments.attachmentId,
                  rows.map((row) => row.id),
                ),
              ),
            )
          const protectedIds = new Set(associated.map((row) => row.id))
          const unused = rows.filter((row) => !protectedIds.has(row.id)).map((row) => row.id)
          if (unused.length)
            await transaction
              .update(attachments)
              .set({ expiresAt: new Date() })
              .where(
                and(
                  eq(attachments.userId, context.userId),
                  eq(attachments.workspaceId, context.workspaceId),
                  inArray(attachments.id, unused),
                ),
              )
        }
      }
      return { status: 'discarded' as const, retainedMessageIds }
    })
  }
  return {
    reserve: async ({
      userId,
      workspaceId,
      deliveryKey,
      id,
      payloadHash,
      to,
      cc,
      bcc,
      recipientName,
      subject,
      html,
      text,
      attachments: references,
    }) =>
      database.transaction(async (transaction) => {
        if (!workspaceId || !userId) throw new Error('Mail workspace context is required')
        const inserted = await transaction
          .insert(outgoingEmails)
          .values({
            userId,
            workspaceId,
            deliveryKey,
            deliveryState: 'ready',
            id,
            payloadHash,
            to,
            cc,
            bcc,
            recipientName,
            subject,
            html,
            text,
          })
          .onConflictDoNothing()
          .returning({ id: outgoingEmails.id })
        const [record] = await transaction
          .select({
            id: outgoingEmails.id,
            payloadHash: outgoingEmails.payloadHash,
            providerId: outgoingEmails.providerId,
            createdAt: outgoingEmails.createdAt,
            workspaceId: outgoingEmails.workspaceId,
            deliveryKey: outgoingEmails.deliveryKey,
            deliveryState: outgoingEmails.deliveryState,
          })
          .from(outgoingEmails)
          .where(and(eq(outgoingEmails.userId, userId), eq(outgoingEmails.id, id)))
          .for('update')
        if (!record) throw new Error('Email reservation unavailable')
        if (record.workspaceId !== workspaceId)
          throw new MessageConflictError('The message belongs to another workspace')
        if (record.deliveryState === 'discarded')
          throw new MessageConflictError('The message was discarded')
        // Existing reservations already hold the immutable association snapshot, including after a failed send.
        if (!inserted.length || !references.length) return record
        const ids = references.map((reference) => reference.id)
        if (ids.length > 10 || new Set(ids).size !== ids.length)
          throw new Error('Invalid attachment references')
        const rows = await transaction
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.userId, userId),
              eq(attachments.workspaceId, workspaceId),
              inArray(attachments.id, ids),
              eq(attachments.status, 'clean'),
              gt(attachments.expiresAt, new Date()),
            ),
          )
          .orderBy(asc(attachments.id))
          .for('update')
        if (rows.length !== ids.length || rows.reduce((sum, row) => sum + row.size, 0) > 20_000_000)
          throw new Error('Attachment unavailable')
        const byId = new Map(rows.map((row) => [row.id, row]))
        await transaction.insert(outgoingEmailAttachments).values(
          references.map((reference, position) => {
            const row = byId.get(reference.id)
            if (!row?.finalKey) throw new Error('Attachment unavailable')
            return {
              userId,
              workspaceId,
              messageId: id,
              attachmentId: row.id,
              position,
              contentId: reference.contentId ?? null,
              filename: row.filename,
              contentType: row.contentType,
              size: row.size,
              sha256: row.sha256,
              objectKey: row.finalKey,
            }
          }),
        )
        return record
      }),
    beginAttempt: async (context, id) => {
      assertMailContext(context)
      return database.transaction(async (transaction) => {
        const predicate = and(
          eq(outgoingEmails.userId, context.userId),
          eq(outgoingEmails.workspaceId, context.workspaceId),
          eq(outgoingEmails.id, id),
        )
        const [record] = await transaction
          .select()
          .from(outgoingEmails)
          .where(predicate)
          .for('update')
        if (!record) throw new MessageConflictError('Email reservation unavailable')
        if (record.providerId) return null
        if (record.deliveryState === 'discarded')
          throw new MessageConflictError('The message was discarded')
        const token = randomUUID()
        await transaction
          .update(outgoingEmails)
          .set({ deliveryState: 'uncertain', attemptToken: token })
          .where(predicate)
        return {
          token,
          canReject: record.deliveryState === 'ready' || record.deliveryState === 'rejected',
        }
      })
    },
    markRejected: async (context, id, attempt) => {
      assertMailContext(context)
      // Once an earlier attempt is uncertain, a later rejection cannot prove it was never accepted.
      if (!attempt.canReject) return
      await database
        .update(outgoingEmails)
        .set({ deliveryState: 'rejected', attemptToken: null })
        .where(
          and(
            eq(outgoingEmails.userId, context.userId),
            eq(outgoingEmails.workspaceId, context.workspaceId),
            eq(outgoingEmails.id, id),
            eq(outgoingEmails.attemptToken, attempt.token),
            eq(outgoingEmails.deliveryState, 'uncertain'),
            isNull(outgoingEmails.providerId),
          ),
        )
    },
    discard,
    cleanupAbandoned: async () => {
      const candidates = await database
        .select({
          id: outgoingEmails.id,
          workspaceId: outgoingEmails.workspaceId,
          userId: outgoingEmails.userId,
        })
        .from(outgoingEmails)
        .where(
          and(
            inArray(outgoingEmails.deliveryState, ['ready', 'rejected']),
            isNull(outgoingEmails.providerId),
            isNotNull(outgoingEmails.workspaceId),
            lt(outgoingEmails.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
          ),
        )
        .orderBy(asc(outgoingEmails.createdAt), asc(outgoingEmails.id))
        .limit(100)
      let discarded = 0
      for (const row of candidates) {
        if (!row.workspaceId) continue
        const result = await discard(
          { workspaceId: row.workspaceId, userId: row.userId },
          { messageIds: [row.id], attachmentIds: [] },
        )
        if (!result.retainedMessageIds.length) discarded++
      }
      return discarded
    },
    markSent: async (context, id, providerId) => {
      assertMailContext(context)
      await database
        .update(outgoingEmails)
        .set({ providerId, sentAt: new Date(), deliveryState: 'sent', attemptToken: null })
        .where(
          and(
            eq(outgoingEmails.userId, context.userId),
            eq(outgoingEmails.workspaceId, context.workspaceId),
            eq(outgoingEmails.id, id),
          ),
        )
    },
    listSent: async (userId, offset) => {
      const rows = await database
        .select(sentSelection)
        .from(outgoingEmails)
        .where(and(eq(outgoingEmails.userId, userId), isNotNull(outgoingEmails.providerId)))
        .orderBy(desc(outgoingEmails.sentAt), desc(outgoingEmails.id))
        .limit(21)
        .offset(offset)
      const metadata = await sentAttachments(
        userId,
        rows.map(({ id }) => id),
      )
      return rows.map((row) => ({ ...row, attachments: metadata.get(row.id) ?? [] }))
    },
    findSent: async (context, id) => {
      assertMailContext(context)
      const { userId, workspaceId } = context
      const [record] = await database
        .select({ ...sentSelection, html: outgoingEmails.html })
        .from(outgoingEmails)
        .where(
          and(
            eq(outgoingEmails.userId, userId),
            eq(outgoingEmails.id, id),
            eq(outgoingEmails.workspaceId, workspaceId),
            isNotNull(outgoingEmails.providerId),
          ),
        )
      if (!record) return null
      const metadata = await sentAttachments(userId, [record.id])
      return { ...record, attachments: metadata.get(record.id) ?? [] }
    },
  }
}
