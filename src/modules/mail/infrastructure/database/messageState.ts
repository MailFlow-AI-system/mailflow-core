import { and, isNotNull, isNull, type SQL } from 'drizzle-orm'
import type { MailClient, MessageState, MessageStateView } from '../../inbox/listMessages/types.js'
import {
  actionPatch,
  folderOf,
  type MailFolder,
  type MessageAction,
  type MessageActionResult,
  type MessagePatch,
} from '../../inbox/messageActions/contract.js'
import { messages, messageUserStates } from './schema/messages.js'

type StateRow = {
  readAt: Date | null
  starredAt: Date | null
  archivedAt: Date | null
  archivedBy: string | null
  trashedAt: Date | null
  trashedBy: string | null
  spamAt: Date | null
  spamBy: string | null
}

export const stateColumns = {
  readAt: messageUserStates.readAt,
  starredAt: messageUserStates.starredAt,
  archivedAt: messages.archivedAt,
  archivedBy: messages.archivedBy,
  trashedAt: messages.trashedAt,
  trashedBy: messages.trashedBy,
  spamAt: messages.spamAt,
  spamBy: messages.spamBy,
}

export function toMessageState(row: StateRow): MessageState {
  const timestamps = {
    archivedAt: row.archivedAt?.toISOString() ?? null,
    trashedAt: row.trashedAt?.toISOString() ?? null,
    spamAt: row.spamAt?.toISOString() ?? null,
  }
  return {
    isRead: row.readAt !== null,
    isStarred: row.starredAt !== null,
    folder: folderOf(timestamps),
    archivedAt: timestamps.archivedAt,
    archivedBy: row.archivedBy,
    trashedAt: timestamps.trashedAt,
    trashedBy: row.trashedBy,
    spamAt: timestamps.spamAt,
    spamBy: row.spamBy,
  }
}

// These predicates must match the partial folder indexes declared on mail.message.
export function folderFilter(folder: MailFolder): SQL | undefined {
  switch (folder) {
    case 'inbox':
      return and(isNull(messages.archivedAt), isNull(messages.trashedAt), isNull(messages.spamAt))
    case 'archive':
      return and(
        isNotNull(messages.archivedAt),
        isNull(messages.trashedAt),
        isNull(messages.spamAt),
      )
    case 'trash':
      return isNotNull(messages.trashedAt)
    case 'spam':
      return and(isNotNull(messages.spamAt), isNull(messages.trashedAt))
    case 'starred':
      return and(
        isNotNull(messageUserStates.starredAt),
        isNull(messages.trashedAt),
        isNull(messages.spamAt),
      )
  }
}

const stateSelect = `select m.id,
  s.read_at as "readAt", s.starred_at as "starredAt",
  m.archived_at as "archivedAt", m.archived_by as "archivedBy",
  m.trashed_at as "trashedAt", m.trashed_by as "trashedBy",
  m.spam_at as "spamAt", m.spam_by as "spamBy"
  from mail.message m
  left join mail.message_user_state s
    on s.workspace_id = m.workspace_id and s.message_id = m.id and s.user_id = $2
  where m.workspace_id = $1 and m.id = $3`

export async function readMessageState(
  client: MailClient,
  workspaceId: string,
  userId: string,
  id: string,
): Promise<MessageStateView | null> {
  const { rows } = await client.query<StateRow & { id: string }>(stateSelect, [
    workspaceId,
    userId,
    id,
  ])
  const row = rows[0]
  return row ? { id: row.id, ...toMessageState(row) } : null
}

/** Marks the message read for the user, keeping the first read time. */
export async function markRead(
  client: MailClient,
  workspaceId: string,
  userId: string,
  id: string,
) {
  await client.query(
    `insert into mail.message_user_state (workspace_id, user_id, message_id, read_at)
    values ($1, $2, $3, now())
    on conflict (workspace_id, user_id, message_id)
    do update set read_at = coalesce(mail.message_user_state.read_at, excluded.read_at)`,
    [workspaceId, userId, id],
  )
}

/**
 * Locks the existing messages among `ids` and applies the patch to them. Setting a flag that is
 * already set keeps its original timestamp and actor; clearing it clears both.
 */
export async function applyPatch(
  client: MailClient,
  workspaceId: string,
  userId: string,
  ids: string[],
  patch: MessagePatch,
): Promise<Set<string>> {
  const flag = (value: boolean | undefined) => (value === undefined ? null : value)
  const changesFolder =
    patch.archived !== undefined || patch.trashed !== undefined || patch.spam !== undefined
  // Key share still blocks a concurrent permanent delete while per-user state is written.
  const { rows } = await client.query<{ id: string }>(
    `select id from mail.message where workspace_id = $1 and id = any($2::uuid[])
    order by id for ${changesFolder ? 'no key update' : 'key share'}`,
    [workspaceId, ids],
  )
  const existing = rows.map((row) => row.id)
  if (!existing.length) return new Set()

  if (changesFolder) {
    await client.query(
      `update mail.message set
        archived_at = case when $3::boolean is null then archived_at when $3 then coalesce(archived_at, now()) end,
        archived_by = case when $3::boolean is null then archived_by when $3 then coalesce(archived_by, $6) end,
        trashed_at = case when $4::boolean is null then trashed_at when $4 then coalesce(trashed_at, now()) end,
        trashed_by = case when $4::boolean is null then trashed_by when $4 then coalesce(trashed_by, $6) end,
        spam_at = case when $5::boolean is null then spam_at when $5 then coalesce(spam_at, now()) end,
        spam_by = case when $5::boolean is null then spam_by when $5 then coalesce(spam_by, $6) end
      where workspace_id = $1 and id = any($2::uuid[])`,
      [workspaceId, existing, flag(patch.archived), flag(patch.trashed), flag(patch.spam), userId],
    )
  }

  if (patch.read !== undefined || patch.starred !== undefined) {
    await client.query(
      `insert into mail.message_user_state (workspace_id, user_id, message_id, read_at, starred_at)
      select $1, $2, message_id, case when $4::boolean then now() end, case when $5::boolean then now() end
      from unnest($3::uuid[]) as message_id
      on conflict (workspace_id, user_id, message_id) do update set
        read_at = case when $4::boolean is null then mail.message_user_state.read_at
          when $4 then coalesce(mail.message_user_state.read_at, now()) end,
        starred_at = case when $5::boolean is null then mail.message_user_state.starred_at
          when $5 then coalesce(mail.message_user_state.starred_at, now()) end`,
      [workspaceId, userId, existing, flag(patch.read), flag(patch.starred)],
    )
  }
  return new Set(existing)
}

/** Deletes messages in Trash; label links and every member's state cascade with them. */
async function deletePermanently(client: MailClient, workspaceId: string, ids: string[]) {
  const { rows } = await client.query<{ id: string; trashed: boolean }>(
    `select id, trashed_at is not null as trashed from mail.message
    where workspace_id = $1 and id = any($2::uuid[]) order by id for update`,
    [workspaceId, ids],
  )
  const trashed = rows.filter((row) => row.trashed).map((row) => row.id)
  if (trashed.length)
    await client.query(
      'delete from mail.message where workspace_id = $1 and id = any($2::uuid[])',
      [workspaceId, trashed],
    )
  return new Map(rows.map((row) => [row.id, row.trashed] as const))
}

export async function applyAction(
  client: MailClient,
  workspaceId: string,
  userId: string,
  ids: string[],
  action: MessageAction,
): Promise<MessageActionResult[]> {
  if (action === 'delete_permanently') {
    const found = await deletePermanently(client, workspaceId, ids)
    return ids.map((id) => {
      const trashed = found.get(id)
      return { id, status: trashed === undefined ? 'not_found' : trashed ? 'ok' : 'invalid_state' }
    })
  }
  const existing = await applyPatch(client, workspaceId, userId, ids, actionPatch(action))
  return ids.map((id) => ({ id, status: existing.has(id) ? 'ok' : 'not_found' }))
}
