import type { WorkspaceHandoffStore } from '../infrastructure/types/authOptions.js'
import { inIdentityTransaction } from './identityTransaction.js'
import type { WorkspacePool } from './types.js'

export function createWorkspaceHandoffStore(pool: WorkspacePool): WorkspaceHandoffStore {
  return {
    issue: (userId, workspaceId, codeHash) =>
      inIdentityTransaction(pool, userId, async (client) => {
        const result = await client.query<{ slug: string }>(
          'select slug from identity_workspace.issue_workspace_handoff($1, $2)',
          [workspaceId, codeHash],
        )
        return result.rows[0]?.slug ?? null
      }),
    consume: async (codeHash, hostSlug) => {
      const client = await pool.connect()
      try {
        const result = await client.query<{ user_id: string; workspace_id: string }>(
          'select user_id, workspace_id from identity_workspace.consume_workspace_handoff($1, $2)',
          [codeHash, hostSlug],
        )
        const row = result.rows[0]
        return row ? { userId: row.user_id, workspaceId: row.workspace_id } : null
      } finally {
        client.release()
      }
    },
  }
}
