import type { WorkspaceEntryReader, WorkspaceEntryRow } from './entryTypes.js'
import { inIdentityTransaction } from './identityTransaction.js'
import type { WorkspacePool } from './types.js'

export function createWorkspaceEntryReader(pool: WorkspacePool): WorkspaceEntryReader {
  return {
    resolve: (userId) =>
      inIdentityTransaction(pool, userId, async (client) => {
        const result = await client.query<WorkspaceEntryRow>(
          `select o.id, o.name, o.slug, m.role,
          case when p.workspace_id = o.id then 'preference' else 'fallback' end as source
        from identity_workspace.organization o
        join identity_workspace.member m on m.organization_id = o.id
        left join identity_workspace.workspace_preference p on p.user_id = m.user_id
        where m.user_id = $1
        order by (p.workspace_id = o.id) desc nulls last, o.id
        limit 1`,
          [userId],
        )
        const row = result.rows[0]
        if (!row) return { source: 'none', workspace: null }
        const { source, ...workspace } = row
        return { source, workspace }
      }),
  }
}
