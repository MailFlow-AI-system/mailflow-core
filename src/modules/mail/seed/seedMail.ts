import { createHash } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { MailPool } from '../inbox/listMessages/types.js'
import { messages } from '../infrastructure/database/schema/messages.js'
import {
  inUserWorkspaceTransaction,
  inWorkspaceTransaction,
} from '../infrastructure/database/workspaceTransaction.js'
import { seedMailMessages, seedMailStates as seedStateFixtures } from './fixtures.js'

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

const HOUR = 3_600_000

/**
 * Applies the QA read, star and folder state for the workspace owner. The owner's state row also
 * marks a message as already seeded: reruns skip it, so later changes survive, and a folder is
 * only set on a message that has no folder state yet. Only existing QA messages are touched.
 */
export async function seedMailStates(
  pool: MailPool,
  workspaceId: string,
  actorId: string,
): Promise<{ states: number; folders: number }> {
  return inUserWorkspaceTransaction(pool, workspaceId, actorId, async (client) => {
    const entries = seedMailMessages.map((message, index) => {
      const state = seedStateFixtures[index]
      if (!state) throw new Error('Every QA message requires a seed state')
      // Deterministic times after delivery keep reruns and screenshots stable.
      const actedAt = new Date(message.receivedAt.getTime() + 2 * HOUR).toISOString()
      return { id: mailSeedId(workspaceId, message.id), state, actedAt }
    })
    const inserted = await client.query<{ id: string }>(
      `insert into mail.message_user_state (workspace_id, user_id, message_id, read_at, starred_at)
      select $1, $2, seed.id, seed.read_at, seed.starred_at
      from unnest($3::uuid[], $4::timestamptz[], $5::timestamptz[]) as seed(id, read_at, starred_at)
      where exists (select 1 from mail.message m where m.workspace_id = $1 and m.id = seed.id)
      on conflict (workspace_id, user_id, message_id) do nothing
      returning message_id as id`,
      [
        workspaceId,
        actorId,
        entries.map(({ id }) => id),
        entries.map(({ state, actedAt }) => (state.read ? actedAt : null)),
        entries.map(({ state, actedAt }) => (state.starred ? actedAt : null)),
      ],
    )
    const fresh = new Set(inserted.rows.map(({ id }) => id))
    const moved = entries.filter(({ id, state }) => fresh.has(id) && state.folder !== 'inbox')
    const at = (folder: string) =>
      moved.map(({ state, actedAt }) => (state.folder === folder ? actedAt : null))
    const updated = moved.length
      ? await client.query(
          `update mail.message m set
            archived_at = seed.archived_at, archived_by = case when seed.archived_at is not null then $2 end,
            trashed_at = seed.trashed_at, trashed_by = case when seed.trashed_at is not null then $2 end,
            spam_at = seed.spam_at, spam_by = case when seed.spam_at is not null then $2 end
          from unnest($3::uuid[], $4::timestamptz[], $5::timestamptz[], $6::timestamptz[])
            as seed(id, archived_at, trashed_at, spam_at)
          where m.workspace_id = $1 and m.id = seed.id
            and m.archived_at is null and m.trashed_at is null and m.spam_at is null`,
          [workspaceId, actorId, moved.map(({ id }) => id), at('archive'), at('trash'), at('spam')],
        )
      : null
    return { states: fresh.size, folders: updated?.rowCount ?? 0 }
  })
}
