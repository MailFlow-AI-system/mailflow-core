import { text, timestamp } from 'drizzle-orm/pg-core'
import { authUser } from './auth/user.js'
import { identityWorkspaceSchema as schema } from './identityWorkspace.js'
import { workspace } from './workspace.js'

export const workspacePreference = schema.table('workspace_preference', {
  userId: text('user_id')
    .primaryKey()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
