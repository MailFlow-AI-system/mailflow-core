import { and, eq, exists, ilike, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'

import { INBOX_PAGE_SIZE } from '../../inbox/listMessages/listMessages.js'
import type {
  MailMessageRepository,
  MailPool,
  UnreadCounts,
} from '../../inbox/listMessages/types.js'
import {
  applyAction,
  applyPatch,
  folderFilter,
  markRead,
  readMessageState,
  stateColumns,
  toMessageState,
} from './messageState.js'
import { readMessageLabels } from './readMessageLabels.js'
import { attachments, inboxMessageAttachments } from './schema/attachments.js'
import { labels, messageLabels } from './schema/labels.js'
import { messages, messageUserStates } from './schema/messages.js'
import { inUserWorkspaceTransaction } from './workspaceTransaction.js'

export function createMailMessageRepository(pool: MailPool): MailMessageRepository {
  return {
    findMessage: (workspaceId, id, userId) =>
      inUserWorkspaceTransaction(pool, workspaceId, userId, async (client) => {
        const db = drizzle({ client })
        // Key share keeps the message from being deleted before its read state is written.
        const [row] = await db
          .select()
          .from(messages)
          .where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, id)))
          .limit(1)
          .for('key share')
        if (!row) return null
        await markRead(client, workspaceId, userId, id)
        const state = await readMessageState(client, workspaceId, userId, id)
        if (!state) return null
        const storedAttachments = await db
          .select({
            id: attachments.id,
            filename: attachments.filename,
            contentType: attachments.contentType,
            size: attachments.size,
            contentId: inboxMessageAttachments.contentId,
          })
          .from(inboxMessageAttachments)
          .innerJoin(
            attachments,
            and(
              eq(attachments.id, inboxMessageAttachments.attachmentId),
              eq(attachments.userId, inboxMessageAttachments.userId),
              eq(attachments.workspaceId, inboxMessageAttachments.workspaceId),
            ),
          )
          .where(
            and(
              eq(inboxMessageAttachments.workspaceId, workspaceId),
              eq(inboxMessageAttachments.userId, userId),
              eq(inboxMessageAttachments.messageId, id),
              eq(attachments.status, 'clean'),
            ),
          )
          .orderBy(inboxMessageAttachments.position)
        const { id: _id, ...messageState } = state
        return {
          id: row.id,
          subject: row.subject,
          senderName: row.senderName,
          senderEmail: row.senderEmail,
          to: row.to,
          cc: row.cc,
          bcc: row.bcc,
          html: row.html,
          text: row.body,
          date: row.receivedAt.toISOString(),
          attachments: storedAttachments,
          labels: (await readMessageLabels(db, workspaceId, [id])).get(id) ?? [],
          ...messageState,
        }
      }),
    findMessages: ({ workspaceId, userId, folder, search, cursor }) =>
      inUserWorkspaceTransaction(pool, workspaceId, userId, async (client) => {
        const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`

        const db = drizzle({ client })
        const matchingLabel = db
          .select({ labelId: messageLabels.labelId })
          .from(messageLabels)
          .innerJoin(
            labels,
            and(
              eq(labels.workspaceId, messageLabels.workspaceId),
              eq(labels.id, messageLabels.labelId),
            ),
          )
          .where(
            and(
              eq(messageLabels.workspaceId, messages.workspaceId),
              eq(messageLabels.messageId, messages.id),
              ilike(labels.name, pattern),
            ),
          )

        const rows = await db
          .select({
            id: messages.id,
            senderName: messages.senderName,
            subject: messages.subject,
            body: messages.body,
            receivedAt: messages.receivedAt,
            ...stateColumns,
          })
          .from(messages)
          .leftJoin(
            messageUserStates,
            and(
              eq(messageUserStates.workspaceId, messages.workspaceId),
              eq(messageUserStates.messageId, messages.id),
              eq(messageUserStates.userId, userId),
            ),
          )
          .where(
            and(
              eq(messages.workspaceId, workspaceId),
              folderFilter(folder),
              search
                ? or(
                    ilike(messages.senderName, pattern),
                    ilike(messages.senderEmail, pattern),
                    ilike(messages.subject, pattern),
                    ilike(messages.body, pattern),
                    sql`exists (
                      select 1 from jsonb_array_elements_text(
                        '[]'::jsonb || ${messages.to} || ${messages.cc} || ${messages.bcc}
                      ) as recipient(address) where address ilike ${pattern}
                    )`,
                    exists(matchingLabel),
                  )
                : undefined,
              cursor
                ? sql`(${messages.receivedAt}, ${messages.id}) < (${cursor.receivedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
                : undefined,
            ),
          )
          .orderBy(sql`${messages.receivedAt} desc nulls last`, sql`${messages.id} desc nulls last`)
          .limit(INBOX_PAGE_SIZE + 1)
        const labelsByMessage = await readMessageLabels(
          db,
          workspaceId,
          rows.map(({ id }) => id),
        )
        return rows.map(({ id, senderName, subject, body, receivedAt, ...state }) => ({
          id,
          senderName,
          subject,
          body,
          receivedAt,
          labels: labelsByMessage.get(id) ?? [],
          ...toMessageState(state),
        }))
      }),
    countUnread: (workspaceId, userId) =>
      inUserWorkspaceTransaction(pool, workspaceId, userId, async (client) => {
        const { rows } = await client.query<UnreadCounts>(
          `select
            count(*) filter (where m.archived_at is null and m.trashed_at is null and m.spam_at is null)::int as inbox,
            count(*) filter (where s.starred_at is not null and m.trashed_at is null and m.spam_at is null)::int as starred,
            count(*) filter (where m.archived_at is not null and m.trashed_at is null and m.spam_at is null)::int as archive,
            count(*) filter (where m.trashed_at is not null)::int as trash,
            count(*) filter (where m.spam_at is not null and m.trashed_at is null)::int as spam
          from mail.message m
          left join mail.message_user_state s
            on s.workspace_id = m.workspace_id and s.message_id = m.id and s.user_id = $2
          where m.workspace_id = $1 and s.read_at is null`,
          [workspaceId, userId],
        )
        const [counts] = rows
        if (!counts) throw new Error('Unread counts are unavailable')
        return counts
      }),
    updateMessage: (workspaceId, userId, id, patch) =>
      inUserWorkspaceTransaction(pool, workspaceId, userId, async (client) => {
        const existing = await applyPatch(client, workspaceId, userId, [id], patch)
        return existing.size ? readMessageState(client, workspaceId, userId, id) : null
      }),
    applyAction: (workspaceId, userId, ids, action) =>
      inUserWorkspaceTransaction(pool, workspaceId, userId, (client) =>
        applyAction(client, workspaceId, userId, ids, action),
      ),
  }
}
