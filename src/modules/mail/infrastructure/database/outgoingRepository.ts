import { and, desc, eq, isNotNull } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { OutgoingRepository } from '../../outgoing/types.js'
import { outgoingEmails } from './schema/outgoingEmails.js'

export function createOutgoingRepository(database: NodePgDatabase): OutgoingRepository {
  return {
    reserve: async ({ userId, id, payloadHash, to, cc, bcc, subject, html, text }) => {
      await database
        .insert(outgoingEmails)
        .values({ userId, id, payloadHash, to, cc, bcc, subject, html, text })
        .onConflictDoNothing()
      const [record] = await database
        .select({
          id: outgoingEmails.id,
          payloadHash: outgoingEmails.payloadHash,
          providerId: outgoingEmails.providerId,
          createdAt: outgoingEmails.createdAt,
        })
        .from(outgoingEmails)
        .where(and(eq(outgoingEmails.userId, userId), eq(outgoingEmails.id, id)))
      if (!record) throw new Error('Email reservation unavailable')
      return record
    },
    markSent: async (userId, id, providerId) => {
      await database
        .update(outgoingEmails)
        .set({ providerId, sentAt: new Date() })
        .where(and(eq(outgoingEmails.userId, userId), eq(outgoingEmails.id, id)))
    },
    listSent: async (userId, offset) =>
      database
        .select({
          id: outgoingEmails.id,
          to: outgoingEmails.to,
          cc: outgoingEmails.cc,
          bcc: outgoingEmails.bcc,
          subject: outgoingEmails.subject,
          text: outgoingEmails.text,
          sentAt: outgoingEmails.sentAt,
        })
        .from(outgoingEmails)
        .where(and(eq(outgoingEmails.userId, userId), isNotNull(outgoingEmails.providerId)))
        .orderBy(desc(outgoingEmails.sentAt), desc(outgoingEmails.id))
        .limit(21)
        .offset(offset),
  }
}
