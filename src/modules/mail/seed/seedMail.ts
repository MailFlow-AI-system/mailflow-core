import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

import { messages } from '../infrastructure/database/schema/messages.js'
import { seedMailMessages } from './fixtures.js'

export async function seedMail(database: NodePgDatabase): Promise<number> {
  const inserted = await database
    .insert(messages)
    .values(seedMailMessages)
    .onConflictDoNothing({ target: messages.id })
    .returning({ id: messages.id })

  return inserted.length
}
