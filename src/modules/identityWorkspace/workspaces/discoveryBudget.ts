import { randomUUID } from 'node:crypto'
import type { DiscoveryBudgetRow, WorkspacePool } from './types.js'

export function createDiscoveryBudget(pool: WorkspacePool) {
  return async (userId: string) => {
    const client = await pool.connect()
    try {
      const result = await client.query<DiscoveryBudgetRow>(
        `insert into identity_workspace.rate_limit (id, key, count, last_request)
         values ($3, $1, 1, $2)
         on conflict (key) do update set
           count = case when identity_workspace.rate_limit.last_request <= $2 - 60000
             then 1 else least(identity_workspace.rate_limit.count + 1, 121) end,
           last_request = case when identity_workspace.rate_limit.last_request <= $2 - 60000
             then $2 else identity_workspace.rate_limit.last_request end
         returning count, last_request`,
        [`workspace-discovery:${userId}`, Date.now(), randomUUID()],
      )
      const row = result.rows[0]
      if (!row) throw new Error('Missing request budget')
      return row.count <= 120
        ? 0
        : Math.max(1, Math.ceil((Number(row.last_request) + 60000 - Date.now()) / 1000))
    } finally {
      client.release()
    }
  }
}
