import { and, ilike, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

import { INBOX_PAGE_SIZE } from '../../inbox/listMessages/listMessages.js'
import type { MailMessageRepository } from '../../inbox/listMessages/types.js'
import { messages } from './schema/messages.js'

export function createMailMessageRepository(database: NodePgDatabase): MailMessageRepository {
  return {
    findMessages: async ({ search, cursor }) => {
      const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`

      return database
        .select()
        .from(messages)
        .where(
          and(
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
    },
  }
}
