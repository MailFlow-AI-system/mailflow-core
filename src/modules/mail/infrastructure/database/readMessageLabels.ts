import { and, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { Label } from '../../labels/types.js'
import { labels, messageLabels, sentLabels } from './schema/labels.js'

export async function readMessageLabels(
  database: Pick<NodePgDatabase, 'select'>,
  workspaceId: string,
  messageIds: string[],
  sentOwner?: string,
) {
  const byMessage = new Map<string, Label[]>()
  if (!messageIds.length) return byMessage
  const association = sentOwner === undefined ? messageLabels : sentLabels
  const rows = await database
    .select({
      messageId: association.messageId,
      id: labels.id,
      name: labels.name,
      color: labels.color,
    })
    .from(association)
    .innerJoin(
      labels,
      and(eq(labels.workspaceId, association.workspaceId), eq(labels.id, association.labelId)),
    )
    .where(
      and(
        eq(association.workspaceId, workspaceId),
        inArray(association.messageId, messageIds),
        sentOwner === undefined ? undefined : eq(sentLabels.userId, sentOwner),
      ),
    )
    .orderBy(sql`lower(${labels.name}) collate "C"`, labels.id)
  for (const { messageId, ...label } of rows) {
    const group = byMessage.get(messageId)
    if (group) group.push(label)
    else byMessage.set(messageId, [label])
  }
  return byMessage
}
