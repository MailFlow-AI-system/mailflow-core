import { bigint, integer, text, uniqueIndex } from 'drizzle-orm/pg-core'

import { identityWorkspaceSchema } from '../identityWorkspace.js'

export const authRateLimit = identityWorkspaceSchema.table(
  'rate_limit',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    count: integer('count').notNull(),
    lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
  },
  (table) => [uniqueIndex('rate_limit_key_unique').on(table.key)],
)
