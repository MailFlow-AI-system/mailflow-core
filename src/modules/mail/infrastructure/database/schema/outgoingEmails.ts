import { index, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { mailSchema } from './messages.js'

export const outgoingEmails = mailSchema.table(
  'outgoing_email',
  {
    id: uuid('id').notNull(),
    userId: text('user_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    to: jsonb('to').$type<string[]>().notNull(),
    cc: jsonb('cc').$type<string[]>().notNull(),
    bcc: jsonb('bcc').$type<string[]>().notNull(),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    text: text('text').notNull(),
    providerId: text('provider_id'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id] }),
    index('outgoing_email_user_sent_idx').on(table.userId, table.sentAt.desc(), table.id.desc()),
  ],
)
