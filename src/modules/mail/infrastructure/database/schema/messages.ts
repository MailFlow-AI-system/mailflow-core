import { index, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const mailSchema = pgSchema('mail')

export const messages = mailSchema.table(
  'message',
  {
    workspaceId: text('workspace_id').notNull(),
    id: uuid('id').defaultRandom().primaryKey(),
    senderName: text('sender_name').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [
    index('message_workspace_received_at_id_idx').on(
      table.workspaceId,
      table.receivedAt.desc(),
      table.id.desc(),
    ),
  ],
)
