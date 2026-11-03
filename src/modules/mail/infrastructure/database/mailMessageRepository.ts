import { and, eq, exists, ilike, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'

import { INBOX_PAGE_SIZE } from '../../inbox/listMessages/listMessages.js'
import type { MailMessageRepository, MailPool } from '../../inbox/listMessages/types.js'
import { readMessageLabels } from './readMessageLabels.js'
import { attachments, inboxMessageAttachments } from './schema/attachments.js'
import { labels, messageLabels } from './schema/labels.js'
import { messages } from './schema/messages.js'
import { inWorkspaceTransaction } from './workspaceTransaction.js'

export function createMailMessageRepository(pool: MailPool): MailMessageRepository {
  return {
    findMessage: (workspaceId, id, userId) =>
      inWorkspaceTransaction(pool, workspaceId, async (client) => {
        const db = drizzle({ client })
        const [row] = await db
          .select()
          .from(messages)
          .where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, id)))
          .limit(1)
        if (!row) return null
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
        }
      }),
    findMessages: ({ workspaceId, search, cursor }) =>
      inWorkspaceTransaction(pool, workspaceId, async (client) => {
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
          })
          .from(messages)
          .where(
            and(
              eq(messages.workspaceId, workspaceId),
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
        return rows.map((row) => ({ ...row, labels: labelsByMessage.get(row.id) ?? [] }))
      }),
  }
}
