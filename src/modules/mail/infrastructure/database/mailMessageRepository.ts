import { and, eq, ilike, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'

import { INBOX_PAGE_SIZE } from '../../inbox/listMessages/listMessages.js'
import type { MailMessageRepository, MailPool } from '../../inbox/listMessages/types.js'
import { messages } from './schema/messages.js'
import { inWorkspaceTransaction } from './workspaceTransaction.js'

export function createMailMessageRepository(pool: MailPool): MailMessageRepository {
  return {
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
