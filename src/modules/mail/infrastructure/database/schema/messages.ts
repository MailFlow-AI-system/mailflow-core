import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgPolicy,
  pgSchema,
  primaryKey,
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
      // Folder state is shared by the workspace and records who moved the message and when.
      archivedAt: timestamp('archived_at', { withTimezone: true, precision: 3 }),
      archivedBy: text('archived_by'),
      trashedAt: timestamp('trashed_at', { withTimezone: true, precision: 3 }),
      trashedBy: text('trashed_by'),
      spamAt: timestamp('spam_at', { withTimezone: true, precision: 3 }),
      spamBy: text('spam_by'),
    },
    (table) => [
      check('message_workspace_required', sql`${table.workspaceId} is not null`),
      check(
        'message_archived_actor_check',
        sql`(${table.archivedAt} is null) = (${table.archivedBy} is null)`,
      ),
      check(
        'message_trashed_actor_check',
        sql`(${table.trashedAt} is null) = (${table.trashedBy} is null)`,
      ),
      check('message_spam_actor_check', sql`(${table.spamAt} is null) = (${table.spamBy} is null)`),
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
      // Partial indexes keep each folder's (received_at, id) pagination an index range scan.
      // Their predicates must stay identical to the folder filters in mailMessageRepository.
      index('message_inbox_folder_idx')
        .on(table.workspaceId, table.receivedAt.desc(), table.id.desc())
        .where(
          sql`${table.archivedAt} is null and ${table.trashedAt} is null and ${table.spamAt} is null`,
        ),
      index('message_archive_folder_idx')
        .on(table.workspaceId, table.receivedAt.desc(), table.id.desc())
        .where(
          sql`${table.archivedAt} is not null and ${table.trashedAt} is null and ${table.spamAt} is null`,
        ),
      index('message_trash_folder_idx')
        .on(table.workspaceId, table.receivedAt.desc(), table.id.desc())
        .where(sql`${table.trashedAt} is not null`),
      index('message_spam_folder_idx')
        .on(table.workspaceId, table.receivedAt.desc(), table.id.desc())
        .where(sql`${table.spamAt} is not null and ${table.trashedAt} is null`),
    ],
  )
  .enableRLS()

// Read and star state belongs to one member of the workspace.
export const messageUserStates = mailSchema
  .table(
    'message_user_state',
    {
      workspaceId: text('workspace_id').notNull(),
      userId: text('user_id').notNull(),
      messageId: uuid('message_id').notNull(),
      readAt: timestamp('read_at', { withTimezone: true, precision: 3 }),
      starredAt: timestamp('starred_at', { withTimezone: true, precision: 3 }),
    },
    (table) => [
      primaryKey({ columns: [table.workspaceId, table.userId, table.messageId] }),
      foreignKey({
        columns: [table.workspaceId, table.messageId],
        foreignColumns: [messages.workspaceId, messages.id],
      }).onDelete('cascade'),
      index('message_user_state_message_idx').on(table.workspaceId, table.messageId),
      pgPolicy('message_user_state_owner', {
        using: sql`${table.workspaceId} = nullif(current_setting('mailflow.workspace_id', true), '') and ${table.userId} = nullif(current_setting('mailflow.user_id', true), '')`,
        withCheck: sql`${table.workspaceId} = nullif(current_setting('mailflow.workspace_id', true), '') and ${table.userId} = nullif(current_setting('mailflow.user_id', true), '')`,
      }),
    ],
  )
  .enableRLS()
