import { createHash } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { MailPool } from '../inbox/listMessages/types.js'
import { messages } from '../infrastructure/database/schema/messages.js'
import { inWorkspaceTransaction } from '../infrastructure/database/workspaceTransaction.js'
import { seedMailMessages } from './fixtures.js'

export function mailSeedId(workspaceId: string, fixtureKey: string): string {
  const namespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex')
  const bytes = createHash('sha1')
    .update(namespace)
    .update(JSON.stringify([workspaceId, fixtureKey]))
    .digest()
    .subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function seedMail(pool: MailPool, workspaceId: string): Promise<number> {
  return inWorkspaceTransaction(pool, workspaceId, async (client) => {
    const inserted = await drizzle({ client })
      .insert(messages)
      .values(
        seedMailMessages.map((message) => ({
          ...message,
          workspaceId,
          id: mailSeedId(workspaceId, message.id),
        })),
      )
      .onConflictDoNothing({ target: messages.id })
      .returning({ id: messages.id })
    return inserted.length
  })
}
