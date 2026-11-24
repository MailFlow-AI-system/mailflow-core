import { index, text, timestamp } from 'drizzle-orm/pg-core'
import { authUser } from './auth/user.js'
import { identityWorkspaceSchema as schema } from './identityWorkspace.js'
import { workspace } from './workspace.js'

// One-time codes that move a signed-in user to another workspace host. Only the SHA-256 of
// the code is stored; rows are written and consumed exclusively through privileged functions.
export const workspaceHandoff = schema.table(
  'workspace_handoff',
  {
    codeHash: text('code_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('workspace_handoff_expires_at_idx').on(table.expiresAt)],
)
