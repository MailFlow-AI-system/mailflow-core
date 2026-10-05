import { inIdentityTransaction } from './identityTransaction.js'
import type { WorkspacePool, WorkspaceReader, WorkspaceSummary } from './types.js'

const pageSize = 50
const summaryQuery = `select o.id, o.name, o.slug, m.role
  from identity_workspace.organization o
  join identity_workspace.member m on m.organization_id = o.id
  where m.user_id = $1`

export function createWorkspaceReader(pool: WorkspacePool): WorkspaceReader {
  return {
    list: (userId, cursor) =>
      inIdentityTransaction(pool, userId, async (client) => {
        const result = await client.query<WorkspaceSummary>(
          `${summaryQuery} and ($2::text is null or o.id > $2)
         order by o.id limit $3`,
          [userId, cursor ?? null, pageSize + 1],
        )
        const items = result.rows.slice(0, pageSize)
        return {
          items,
          nextCursor: result.rows.length > pageSize ? (items.at(-1)?.id ?? null) : null,
        }
      }),
    context: (userId, slug) =>
      inIdentityTransaction(pool, userId, async (client) => {
        const result = await client.query<WorkspaceSummary>(
          `${summaryQuery} and o.slug = $2 limit 1`,
          [userId, slug],
        )
        return result.rows[0] ?? null
      }),
  }
}
