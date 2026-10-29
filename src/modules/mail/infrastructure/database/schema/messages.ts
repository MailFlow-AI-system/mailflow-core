import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgPolicy,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const mailSchema = pgSchema('mail')

export const messages = mailSchema
  .table(
    'message',
    {
      workspaceId: text('workspace_id'),
      id: uuid('id').defaultRandom().primaryKey(),
      senderName: text('sender_name').notNull(),
      senderEmail: text('sender_email'),
      to: jsonb('to').$type<string[]>().default([]).notNull(),
      cc: jsonb('cc').$type<string[]>().default([]).notNull(),
      bcc: jsonb('bcc').$type<string[]>().default([]).notNull(),
      html: text('html'),
      subject: text('subject').notNull(),
      body: text('body').notNull(),
      receivedAt: timestamp('received_at', { withTimezone: true, precision: 3 }).notNull(),
    },
    (table) => [
      check('message_workspace_required', sql`${table.workspaceId} is not null`),
      pgPolicy('message_workspace', {
        using: sql`${table.workspaceId} = nullif(current_setting('mailflow.workspace_id', true), '')`,
        withCheck: sql`${table.workspaceId} = nullif(current_setting('mailflow.workspace_id', true), '')`,
      }),
      uniqueIndex('message_workspace_identity_idx').on(table.workspaceId, table.id),
      index('message_workspace_received_at_id_idx').on(
        table.workspaceId,
        table.receivedAt.desc(),
        table.id.desc(),
      ),
    ],
  )
  .enableRLS()
