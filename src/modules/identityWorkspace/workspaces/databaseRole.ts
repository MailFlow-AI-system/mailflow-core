import type { DatabaseRoleResult, WorkspacePool } from './types.js'

export async function assertWorkspaceDatabaseRole(pool: WorkspacePool) {
  const client = await pool.connect()
  try {
    const result = await client.query<DatabaseRoleResult>(`select
      r.rolsuper or r.rolbypassrls or exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'identity_workspace' and c.relname in ('organization', 'member', 'invitation')
          and (pg_has_role(current_user, c.relowner, 'MEMBER') or not c.relrowsecurity or not c.relforcerowsecurity)
      ) or (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='identity_workspace' and c.relname in ('organization','member','invitation')) <> 3
      as unsafe from pg_roles r where r.rolname = current_user`)
    if (!result.rows[0] || result.rows[0].unsafe) {
      throw new Error('Workspace access requires a non-owner role without SUPERUSER or BYPASSRLS')
    }
  } finally {
    client.release()
  }
}
