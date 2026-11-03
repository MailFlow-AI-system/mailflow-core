import type { MailClient, MailPool } from '../inbox/listMessages/types.js'
import { inWorkspaceTransaction } from '../infrastructure/database/workspaceTransaction.js'
import type { Label, LabelRepository, LabelTarget } from './types.js'

const colors = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#9333ea',
  '#ea580c',
  '#0891b2',
  '#be185d',
  '#4f46e5',
]
const selectLabels = 'select l.id, l.name, l.color from mail.label l'

async function targetExists(
  client: MailClient,
  workspace: string,
  user: string,
  target: LabelTarget,
  id: string,
) {
  const result =
    target === 'messages'
      ? await client.query('select 1 from mail.message where workspace_id = $1 and id = $2', [
          workspace,
          id,
        ])
      : await client.query(
          'select 1 from mail.outgoing_email where workspace_id = $1 and user_id = $2 and id = $3 and provider_id is not null',
          [workspace, user, id],
        )
  return result.rowCount !== 0
}
async function getLabels(
  client: MailClient,
  workspace: string,
  user: string,
  target: LabelTarget,
  id: string,
): Promise<Label[]> {
  const table = target === 'messages' ? 'message_label' : 'sent_label'
  const result = await client.query<Label>(
    `${selectLabels} join mail.${table} ml on ml.workspace_id = l.workspace_id and ml.label_id = l.id where ml.workspace_id = $1 and ml.message_id = $2 ${target === 'sent' ? 'and ml.user_id = $3' : ''} order by lower(l.name) collate "C", l.id`,
    target === 'sent' ? [workspace, id, user] : [workspace, id],
  )
  return result.rows
}
export function createLabelRepository(pool: MailPool): LabelRepository {
  return {
    searchLabels: (workspace, query, cursor) =>
      inWorkspaceTransaction(pool, workspace, async (client) => {
        const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`
        const rows = await client.query<Label>(
          `${selectLabels} where l.workspace_id = $1 and l.name ilike $2 and ($3::text is null or (lower(l.name) collate "C", l.id) > (lower($3) collate "C", $4::uuid)) order by lower(l.name) collate "C", l.id limit 6`,
          [workspace, pattern, cursor?.name ?? null, cursor?.id ?? null],
        )
        const exact = query
          ? await client.query<Label>(
              `${selectLabels} where l.workspace_id = $1 and lower(l.name) = lower($2) limit 1`,
              [workspace, query],
            )
          : null
        const items = rows.rows.slice(0, 5)
        const last = items.at(-1)
        return {
          items,
          nextCursor: rows.rows.length > 5 && last ? { name: last.name, id: last.id } : null,
          exactMatch: exact?.rows[0] ?? null,
        }
      }),
    createLabel: (workspace, name) =>
      inWorkspaceTransaction(pool, workspace, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `mailflow-label-colors:${workspace}`,
        ])
        const usage = await client.query<{ color: string; count: string }>(
          'select color, count(*)::text as count from mail.label where workspace_id = $1 group by color',
          [workspace],
        )
        const counts = new Map(usage.rows.map((row) => [row.color, Number(row.count)]))
        const color = colors.reduce(
          (best, candidate) =>
            (counts.get(candidate) ?? 0) < (counts.get(best) ?? 0) ? candidate : best,
          colors[0] ?? '#2563eb',
        )
        const result = await client.query<Label>(
          'insert into mail.label (workspace_id, name, color) values ($1, $2, $3) on conflict do nothing returning id, name, color',
          [workspace, name, color],
        )
        return result.rows[0] ?? null
      }),
    messageLabels: (workspace, user, target, id) =>
      inWorkspaceTransaction(pool, workspace, async (client) => {
        if (!(await targetExists(client, workspace, user, target, id))) return null
        return getLabels(client, workspace, user, target, id)
      }),
    changeMessageLabel: (workspace, user, target, id, labelId, add) =>
      inWorkspaceTransaction(pool, workspace, async (client) => {
        if (!(await targetExists(client, workspace, user, target, id))) return null
        const exists = await client.query(
          'select 1 from mail.label where workspace_id = $1 and id = $2',
          [workspace, labelId],
        )
        if (!exists.rowCount) return null
        if (target === 'messages') {
          if (add)
            await client.query(
              'insert into mail.message_label (workspace_id, message_id, label_id) values ($1, $2, $3) on conflict do nothing',
              [workspace, id, labelId],
            )
          else
            await client.query(
              'delete from mail.message_label where workspace_id = $1 and message_id = $2 and label_id = $3',
              [workspace, id, labelId],
            )
        } else {
          if (add)
            await client.query(
              'insert into mail.sent_label (workspace_id, user_id, message_id, label_id) values ($1, $2, $3, $4) on conflict do nothing',
              [workspace, user, id, labelId],
            )
          else
            await client.query(
              'delete from mail.sent_label where workspace_id = $1 and user_id = $2 and message_id = $3 and label_id = $4',
              [workspace, user, id, labelId],
            )
        }
        return getLabels(client, workspace, user, target, id)
      }),
  }
}
