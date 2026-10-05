import { inIdentityTransaction } from './identityTransaction.js'
import type { WorkspacePool, WorkspaceSelection, WorkspaceSummary } from './types.js'

export function createWorkspaceSelection(pool: WorkspacePool): WorkspaceSelection {
  return {
    select: (userId, workspaceId) =>
      inIdentityTransaction(pool, userId, async (client) => {
        const result = await client.query<WorkspaceSummary>(
          'select * from identity_workspace.select_workspace_preference($1)',
          [workspaceId],
        )
        return result.rows[0] ?? null
      }),
  }
}
