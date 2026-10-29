import { and, eq, ilike, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'

import { INBOX_PAGE_SIZE } from '../../inbox/listMessages/listMessages.js'
import type { MailMessageRepository, MailPool } from '../../inbox/listMessages/types.js'
import { attachments, inboxMessageAttachments } from './schema/attachments.js'
import { messages } from './schema/messages.js'
import { inWorkspaceTransaction } from './workspaceTransaction.js'

export function createMailMessageRepository(pool: MailPool): MailMessageRepository {
  return {
    findMessage: (workspaceId, id, userId) =>
      inWorkspaceTransaction(pool, workspaceId, async (client) => {
        const [row] = await drizzle({ client })
          .select()
          .from(messages)
          .where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, id)))
          .limit(1)
        if (!row) return null
        const storedAttachments = await drizzle({ client })
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
        }
      }),
    findMessages: ({ workspaceId, search, cursor }) =>
      inWorkspaceTransaction(pool, workspaceId, async (client) => {
        const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`

        return drizzle({ client })
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
                ? sql`(${ilike(messages.senderName, pattern)} or ${ilike(messages.subject, pattern)} or ${ilike(messages.body, pattern)})`
                : undefined,
              cursor
                ? sql`(${messages.receivedAt}, ${messages.id}) < (${cursor.receivedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
                : undefined,
            ),
          )
          .orderBy(sql`${messages.receivedAt} desc nulls last`, sql`${messages.id} desc nulls last`)
          .limit(INBOX_PAGE_SIZE + 1)
      }),
  }
}
