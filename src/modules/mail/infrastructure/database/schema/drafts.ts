import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import type { DraftContent } from '../../../drafts/contract.js'
import { attachments } from './attachments.js'
import { mailSchema } from './messages.js'

export const drafts = mailSchema
  .table(
    'draft',
    {
      workspaceId: text('workspace_id').notNull(),
      userId: text('user_id').notNull(),
      id: uuid('id').notNull(),
      content: jsonb('content').$type<DraftContent>().notNull(),
      version: integer('version').default(0).notNull(),
      mutationId: uuid('mutation_id'),
      state: text('state').default('active').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true, precision: 3 })
        .defaultNow()
        .notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 })
        .defaultNow()
        .notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.workspaceId, t.userId, t.id] }),
      check('draft_state_check', sql`${t.state} in ('active', 'discarded', 'sent')`),
      check('draft_version_check', sql`${t.version} >= 0`),
      index('draft_owner_updated_idx').on(
        t.workspaceId,
        t.userId,
        t.state,
        t.updatedAt.desc(),
        t.id.desc(),
      ),
      pgPolicy('draft_owner', {
        using: sql`${t.workspaceId} = nullif(current_setting('mailflow.workspace_id', true), '') and ${t.userId} = nullif(current_setting('mailflow.user_id', true), '')`,
        withCheck: sql`${t.workspaceId} = nullif(current_setting('mailflow.workspace_id', true), '') and ${t.userId} = nullif(current_setting('mailflow.user_id', true), '')`,
      }),
    ],
  )
  .enableRLS()

export const draftAttachments = mailSchema.table(
  'draft_attachment',
  {
    workspaceId: text('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    draftId: uuid('draft_id').notNull(),
    attachmentId: uuid('attachment_id').notNull(),
    position: integer('position').notNull(),
    contentId: text('content_id'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId, t.draftId, t.attachmentId] }),
    index('draft_attachment_owner_idx').on(t.workspaceId, t.userId, t.attachmentId),
    foreignKey({
      columns: [t.workspaceId, t.userId, t.draftId],
      foreignColumns: [drafts.workspaceId, drafts.userId, drafts.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.userId, t.attachmentId],
      foreignColumns: [attachments.workspaceId, attachments.userId, attachments.id],
    }).onDelete('restrict'),
    check('draft_attachment_position_check', sql`${t.position} >= 0 and ${t.position} < 10`),
  ],
)
