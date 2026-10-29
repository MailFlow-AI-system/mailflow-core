import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { DeliveryState } from '../../../outgoing/types.js'
import { mailSchema } from './messages.js'

export const outgoingEmails = mailSchema.table(
  'outgoing_email',
  {
    id: uuid('id').notNull(),
    userId: text('user_id').notNull(),
    workspaceId: text('workspace_id'),
    deliveryKey: text('delivery_key'),
    deliveryState: text('delivery_state').$type<DeliveryState>().default('uncertain').notNull(),
    attemptToken: uuid('attempt_token'),
    payloadHash: text('payload_hash').notNull(),
    to: jsonb('to').$type<string[]>().notNull(),
    cc: jsonb('cc').$type<string[]>().notNull(),
    bcc: jsonb('bcc').$type<string[]>().notNull(),
    recipientName: text('recipient_name').default('').notNull(),
    senderEmail: text('sender_email'),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    text: text('text').notNull(),
    providerId: text('provider_id'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id] }),
    uniqueIndex('outgoing_email_workspace_identity_idx').on(
      table.workspaceId,
      table.userId,
      table.id,
    ),
    check('outgoing_email_workspace_required', sql`${table.workspaceId} is not null`),
    check(
      'outgoing_email_delivery_state_check',
      sql`${table.deliveryState} in ('ready', 'rejected', 'uncertain', 'sent', 'discarded')`,
    ),
    index('outgoing_email_user_sent_idx').on(table.userId, table.sentAt.desc(), table.id.desc()),
  ],
)
