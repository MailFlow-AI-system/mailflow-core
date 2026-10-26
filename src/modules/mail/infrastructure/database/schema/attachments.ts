import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { AttachmentStatus } from '../../../attachments/types.js'
import { mailSchema } from './messages.js'
import { outgoingEmails } from './outgoingEmails.js'

export const attachments = mailSchema.table(
  'attachment',
  {
    id: uuid('id').notNull(),
    userId: text('user_id').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    status: text('status').$type<AttachmentStatus>().notNull(),
    temporaryKey: text('temporary_key').notNull(),
    finalKey: text('final_key'),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 })
      .default(sql`now() + interval '24 hours'`)
      .notNull(),
    claimToken: text('claim_token'),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id] }),
    uniqueIndex('attachment_temporary_key_idx').on(table.temporaryKey),
    uniqueIndex('attachment_final_key_idx').on(table.finalKey),
    index('attachment_expiry_idx').on(table.expiresAt, table.status),
    check('attachment_size_check', sql`${table.size} >= 0 and ${table.size} <= 10000000`),
    check('attachment_sha256_check', sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
    check(
      'attachment_status_check',
      sql`${table.status} in ('pending', 'clean', 'rejected', 'error', 'deleting')`,
    ),
    check(
      'attachment_clean_check',
      sql`${table.status} <> 'clean' or ${table.finalKey} is not null`,
    ),
  ],
)

export const outgoingEmailAttachments = mailSchema.table(
  'outgoing_email_attachment',
  {
    userId: text('user_id').notNull(),
    messageId: uuid('message_id').notNull(),
    attachmentId: uuid('attachment_id').notNull(),
    position: integer('position').notNull(),
    contentId: text('content_id'),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    objectKey: text('object_key').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.messageId, table.position] }),
    uniqueIndex('outgoing_attachment_identity_idx').on(
      table.userId,
      table.messageId,
      table.attachmentId,
    ),
    index('outgoing_attachment_owner_idx').on(table.userId, table.attachmentId),
    foreignKey({
      columns: [table.userId, table.messageId],
      foreignColumns: [outgoingEmails.userId, outgoingEmails.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId, table.attachmentId],
      foreignColumns: [attachments.userId, attachments.id],
    }).onDelete('restrict'),
    check(
      'outgoing_attachment_position_check',
      sql`${table.position} >= 0 and ${table.position} < 10`,
    ),
  ],
)
