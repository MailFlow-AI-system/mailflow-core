import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  pgPolicy,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { mailSchema, messages } from './messages.js'
import { outgoingEmails } from './outgoingEmails.js'

export const labels = mailSchema
  .table(
    'label',
    {
      workspaceId: text('workspace_id').notNull(),
      id: uuid('id').defaultRandom().notNull(),
      name: text('name').notNull(),
      color: text('color').notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.workspaceId, t.id] }),
      check('label_name_length_check', sql`char_length(${t.name}) between 1 and 100`),
      uniqueIndex('label_workspace_name_idx').on(t.workspaceId, sql`lower(${t.name})`),
      pgPolicy('label_workspace', {
        using: sql`${t.workspaceId} = nullif(current_setting('mailflow.workspace_id', true), '')`,
        withCheck: sql`${t.workspaceId} = nullif(current_setting('mailflow.workspace_id', true), '')`,
      }),
    ],
  )
  .enableRLS()
export const messageLabels = mailSchema
  .table(
    'message_label',
    {
      workspaceId: text('workspace_id').notNull(),
      messageId: uuid('message_id').notNull(),
      labelId: uuid('label_id').notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.workspaceId, t.messageId, t.labelId] }),
      foreignKey({
        columns: [t.workspaceId, t.messageId],
        foreignColumns: [messages.workspaceId, messages.id],
      }).onDelete('cascade'),
      foreignKey({
        columns: [t.workspaceId, t.labelId],
        foreignColumns: [labels.workspaceId, labels.id],
      }).onDelete('cascade'),
      pgPolicy('message_label_workspace', {
        using: sql`${t.workspaceId} = nullif(current_setting('mailflow.workspace_id', true), '')`,
        withCheck: sql`${t.workspaceId} = nullif(current_setting('mailflow.workspace_id', true), '')`,
      }),
    ],
  )
  .enableRLS()
export const sentLabels = mailSchema
  .table(
    'sent_label',
    {
      workspaceId: text('workspace_id').notNull(),
      userId: text('user_id').notNull(),
      messageId: uuid('message_id').notNull(),
      labelId: uuid('label_id').notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.workspaceId, t.userId, t.messageId, t.labelId] }),
      foreignKey({
        columns: [t.workspaceId, t.userId, t.messageId],
        foreignColumns: [outgoingEmails.workspaceId, outgoingEmails.userId, outgoingEmails.id],
      }).onDelete('cascade'),
      foreignKey({
        columns: [t.workspaceId, t.labelId],
        foreignColumns: [labels.workspaceId, labels.id],
      }).onDelete('cascade'),
      pgPolicy('sent_label_workspace', {
        using: sql`${t.workspaceId} = nullif(current_setting('mailflow.workspace_id', true), '')`,
        withCheck: sql`${t.workspaceId} = nullif(current_setting('mailflow.workspace_id', true), '')`,
      }),
    ],
  )
  .enableRLS()
