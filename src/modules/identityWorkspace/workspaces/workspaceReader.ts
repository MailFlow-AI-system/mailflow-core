import { resolveCapabilities } from '../authorization/roles.js'
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
        const result = await client.query<
          WorkspaceSummary & { custom_capabilities: string[] | null }
        >(
          `select o.id, o.name, o.slug, m.role, r.capabilities as custom_capabilities
         from identity_workspace.organization o
         join identity_workspace.member m on m.organization_id = o.id
         left join identity_workspace.workspace_role r on r.id = m.custom_role_id
         where m.user_id = $1 and o.slug = $2 limit 1`,
          [userId, slug],
        )
        const row = result.rows[0]
        if (!row) return null
        const { custom_capabilities: custom, ...workspace } = row
        return { ...workspace, capabilities: resolveCapabilities(workspace.role, custom) }
      }),
  }
}
