import type { AccountWorkspaceResolver } from '../infrastructure/types/authOptions.js'
import { inIdentityTransaction } from './identityTransaction.js'
import type { WorkspacePool } from './types.js'

// Prefers the requesting host's workspace, then the saved preference, then a stable fallback.
export function createAccountWorkspaceResolver(pool: WorkspacePool): AccountWorkspaceResolver {
  return (userId, hostSlug) =>
    inIdentityTransaction(pool, userId, async (client) => {
      const result = await client.query<{ slug: string }>(
        `select o.slug from identity_workspace.organization o
        join identity_workspace.member m on m.organization_id = o.id
        left join identity_workspace.workspace_preference p on p.user_id = m.user_id
        where m.user_id = $1
        order by (o.slug = $2) desc nulls last, (p.workspace_id = o.id) desc nulls last, o.id
        limit 1`,
        [userId, hostSlug ?? null],
      )
      return result.rows[0]?.slug ?? null
    })
}
