import type { PoolClient } from 'pg'
import type { WorkspaceSlugRow } from './types.js'

export async function initialWorkspaceLogin(
  client: PoolClient,
  userId: string,
  baseOrigin: string,
) {
  await client.query("select set_config('mailflow.user_id', $1, true)", [userId])
  const workspace = await client.query<WorkspaceSlugRow>(
    `select o.slug from identity_workspace.organization o
    join identity_workspace.member m on m.organization_id = o.id
    where m.user_id = $1 and m.role = 'owner' order by o.created_at, o.id limit 1`,
    [userId],
  )
  const url = new URL('/login', baseOrigin)
  if (workspace.rows[0]) url.hostname = `${workspace.rows[0].slug}.${url.hostname}`
  return url.href
}
