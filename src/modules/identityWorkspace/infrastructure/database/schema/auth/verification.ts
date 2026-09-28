import { text, timestamp } from 'drizzle-orm/pg-core'

import { identityWorkspaceSchema } from '../identityWorkspace.js'

export const authVerification = identityWorkspaceSchema.table('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})
