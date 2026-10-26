import { and, asc, desc, eq, gt, inArray, isNotNull } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { OutgoingRepository, SentAttachment } from '../../outgoing/types.js'
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
  return {
    reserve: async ({
      userId,
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
        const inserted = await transaction
          .insert(outgoingEmails)
          .values({ userId, id, payloadHash, to, cc, bcc, recipientName, subject, html, text })
          .onConflictDoNothing()
          .returning({ id: outgoingEmails.id })
        const [record] = await transaction
          .select({
            id: outgoingEmails.id,
            payloadHash: outgoingEmails.payloadHash,
            providerId: outgoingEmails.providerId,
            createdAt: outgoingEmails.createdAt,
          })
          .from(outgoingEmails)
          .where(and(eq(outgoingEmails.userId, userId), eq(outgoingEmails.id, id)))
          .for('update')
        if (!record) throw new Error('Email reservation unavailable')
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
    markSent: async (userId, id, providerId) => {
      await database
        .update(outgoingEmails)
        .set({ providerId, sentAt: new Date() })
        .where(and(eq(outgoingEmails.userId, userId), eq(outgoingEmails.id, id)))
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
    findSent: async (userId, id) => {
      const [record] = await database
        .select({ ...sentSelection, html: outgoingEmails.html })
        .from(outgoingEmails)
        .where(
          and(
            eq(outgoingEmails.userId, userId),
            eq(outgoingEmails.id, id),
            isNotNull(outgoingEmails.providerId),
          ),
        )
      if (!record) return null
      const metadata = await sentAttachments(userId, [record.id])
      return { ...record, attachments: metadata.get(record.id) ?? [] }
    },
  }
}
