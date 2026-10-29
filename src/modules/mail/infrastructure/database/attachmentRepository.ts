import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  AttachmentQuotaError,
  type AttachmentRecord,
  type AttachmentRepository,
} from '../../attachments/types.js'
import { assertMailContext } from '../../context/types.js'
import {
  attachments,
  inboxMessageAttachments,
  outgoingEmailAttachments,
} from './schema/attachments.js'

const leaseMilliseconds = 120_000

export function createAttachmentRepository(database: NodePgDatabase): AttachmentRepository {
  return {
    create: async (record) =>
      database.transaction(async (transaction) => {
        assertMailContext(record)
        // Serialize only this owner's quota check and insert; unrelated owners remain independent.
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`mail.attachment.create:${record.workspaceId}:${record.userId}`}, 0))`,
        )
        const [active] = await transaction
          .select({ count: sql<number>`count(*)::int` })
          .from(attachments)
          .where(
            and(
              eq(attachments.userId, record.userId),
              eq(attachments.workspaceId, record.workspaceId),
              gt(attachments.expiresAt, new Date()),
              notExists(
                transaction
                  .select({ one: sql`1` })
                  .from(inboxMessageAttachments)
                  .where(
                    and(
                      eq(inboxMessageAttachments.userId, attachments.userId),
                      eq(inboxMessageAttachments.workspaceId, attachments.workspaceId),
                      eq(inboxMessageAttachments.attachmentId, attachments.id),
                    ),
                  ),
              ),
              notExists(
                transaction
                  .select({ one: sql`1` })
                  .from(outgoingEmailAttachments)
                  .where(
                    and(
                      eq(outgoingEmailAttachments.userId, attachments.userId),
                      eq(outgoingEmailAttachments.workspaceId, attachments.workspaceId),
                      eq(outgoingEmailAttachments.attachmentId, attachments.id),
                    ),
                  ),
              ),
            ),
          )
        if ((active?.count ?? 0) >= 100)
          throw new AttachmentQuotaError('Attachment upload quota exceeded')
        const [created] = await transaction.insert(attachments).values(record).returning()
        if (!created) throw new Error('Attachment could not be created')
        return created
      }),
    get: async (context, id) => {
      assertMailContext(context)
      const { userId, workspaceId } = context
      const [record] = await database
        .select()
        .from(attachments)
        .where(
          and(
            eq(attachments.userId, userId),
            eq(attachments.workspaceId, workspaceId),
            eq(attachments.id, id),
            ne(attachments.status, 'deleting'),
          ),
        )
      return record ?? null
    },
    claimCompletion: async (context, id, token) => {
      assertMailContext(context)
      const { userId, workspaceId } = context
      const now = new Date()
      const [record] = await database
        .update(attachments)
        .set({ claimToken: token, claimExpiresAt: new Date(now.getTime() + leaseMilliseconds) })
        .where(
          and(
            eq(attachments.userId, userId),
            eq(attachments.workspaceId, workspaceId),
            eq(attachments.id, id),
            inArray(attachments.status, ['pending', 'error']),
            gt(attachments.expiresAt, now),
            or(isNull(attachments.claimToken), lte(attachments.claimExpiresAt, now)),
          ),
        )
        .returning()
      return record ?? null
    },
    finishCompletion: async (context, id, token, patch) => {
      assertMailContext(context)
      const { userId, workspaceId } = context
      if (!['clean', 'rejected', 'error'].includes(patch.status))
        throw new Error('Invalid attachment transition')
      const [record] = await database
        .update(attachments)
        .set({ ...patch, claimToken: null, claimExpiresAt: null })
        .where(
          and(
            eq(attachments.userId, userId),
            eq(attachments.workspaceId, workspaceId),
            eq(attachments.id, id),
            eq(attachments.claimToken, token),
            gt(attachments.claimExpiresAt, new Date()),
            inArray(attachments.status, ['pending', 'error']),
          ),
        )
        .returning()
      return record ?? null
    },
    claimExpired: async (limit, token) =>
      database.transaction(async (transaction) => {
        const now = new Date()
        const rows = await transaction
          .select()
          .from(attachments)
          .where(
            and(
              isNotNull(attachments.workspaceId),
              lte(attachments.expiresAt, now),
              or(isNull(attachments.claimToken), lte(attachments.claimExpiresAt, now)),
              notExists(
                transaction
                  .select({ one: sql`1` })
                  .from(inboxMessageAttachments)
                  .where(
                    and(
                      eq(inboxMessageAttachments.userId, attachments.userId),
                      eq(inboxMessageAttachments.workspaceId, attachments.workspaceId),
                      eq(inboxMessageAttachments.attachmentId, attachments.id),
                    ),
                  ),
              ),
              notExists(
                transaction
                  .select({ one: sql`1` })
                  .from(outgoingEmailAttachments)
                  .where(
                    and(
                      eq(outgoingEmailAttachments.userId, attachments.userId),
                      eq(outgoingEmailAttachments.workspaceId, attachments.workspaceId),
                      eq(outgoingEmailAttachments.attachmentId, attachments.id),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(attachments.expiresAt), asc(attachments.id))
          .limit(Math.min(100, Math.max(0, limit)))
          .for('update', { skipLocked: true })
        if (!rows.length) return []
        // A send may commit after the candidate query's snapshot but before it acquires a row lock.
        // Recheck with a fresh statement while these locks prevent any new association from racing us.
        const associated = await transaction
          .selectDistinct({
            userId: outgoingEmailAttachments.userId,
            workspaceId: outgoingEmailAttachments.workspaceId,
            attachmentId: outgoingEmailAttachments.attachmentId,
          })
          .from(outgoingEmailAttachments)
          .where(
            or(
              ...rows.map((row) =>
                and(
                  eq(outgoingEmailAttachments.userId, row.userId),
                  eq(outgoingEmailAttachments.workspaceId, row.workspaceId as string),
                  eq(outgoingEmailAttachments.attachmentId, row.id),
                ),
              ),
            ),
          )
        const inboxAssociated = await transaction
          .selectDistinct({
            userId: inboxMessageAttachments.userId,
            workspaceId: inboxMessageAttachments.workspaceId,
            attachmentId: inboxMessageAttachments.attachmentId,
          })
          .from(inboxMessageAttachments)
          .where(
            or(
              ...rows.map((row) =>
                and(
                  eq(inboxMessageAttachments.userId, row.userId),
                  eq(inboxMessageAttachments.workspaceId, row.workspaceId as string),
                  eq(inboxMessageAttachments.attachmentId, row.id),
                ),
              ),
            ),
          )
        const protectedIds = new Set(
          [...associated, ...inboxAssociated].map((row) =>
            JSON.stringify([row.workspaceId, row.userId, row.attachmentId]),
          ),
        )
        const claimed: AttachmentRecord[] = []
        for (const row of rows) {
          if (protectedIds.has(JSON.stringify([row.workspaceId, row.userId, row.id]))) continue
          const [record] = await transaction
            .update(attachments)
            .set({
              status: 'deleting',
              claimToken: token,
              claimExpiresAt: new Date(now.getTime() + leaseMilliseconds),
            })
            .where(
              and(
                eq(attachments.workspaceId, row.workspaceId as string),
                eq(attachments.userId, row.userId),
                eq(attachments.id, row.id),
              ),
            )
            .returning()
          if (record) claimed.push(record)
        }
        return claimed
      }),
    deleteClaimed: async (context, id, token) => {
      assertMailContext(context)
      const { userId, workspaceId } = context
      const rows = await database
        .delete(attachments)
        .where(
          and(
            eq(attachments.userId, userId),
            eq(attachments.workspaceId, workspaceId),
            eq(attachments.id, id),
            eq(attachments.status, 'deleting'),
            eq(attachments.claimToken, token),
            gt(attachments.claimExpiresAt, new Date()),
          ),
        )
        .returning({ id: attachments.id })
      return rows.length === 1
    },
    isAssociated: async (context, id) => {
      assertMailContext(context)
      const { userId, workspaceId } = context
      const [association] = await database
        .select({ attachmentId: outgoingEmailAttachments.attachmentId })
        .from(outgoingEmailAttachments)
        .where(
          and(
            eq(outgoingEmailAttachments.userId, userId),
            eq(outgoingEmailAttachments.workspaceId, workspaceId),
            eq(outgoingEmailAttachments.attachmentId, id),
          ),
        )
        .limit(1)
      if (association) return true
      const [inboxAssociation] = await database
        .select({ attachmentId: inboxMessageAttachments.attachmentId })
        .from(inboxMessageAttachments)
        .where(
          and(
            eq(inboxMessageAttachments.userId, userId),
            eq(inboxMessageAttachments.workspaceId, workspaceId),
            eq(inboxMessageAttachments.attachmentId, id),
          ),
        )
        .limit(1)
      return Boolean(inboxAssociation)
    },
    isFinalKeyReferenced: async (key, workspaceId) => {
      const [record] = await database
        .select({ id: attachments.id })
        .from(attachments)
        .where(
          and(
            eq(attachments.finalKey, key),
            workspaceId ? eq(attachments.workspaceId, workspaceId) : undefined,
          ),
        )
        .limit(1)
      return Boolean(record)
    },
  }
}
