import { index, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const mailSchema = pgSchema('mail')

export const messages = mailSchema.table(
  'message',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    senderName: text('sender_name').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [index('message_received_at_id_idx').on(table.receivedAt.desc(), table.id.desc())],
)
