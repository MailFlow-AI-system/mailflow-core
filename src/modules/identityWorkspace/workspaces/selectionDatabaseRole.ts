import type { DatabaseRoleResult, WorkspacePool } from './types.js'

export async function assertWorkspaceSelectionDatabaseRole(pool: WorkspacePool) {
  const client = await pool.connect()
  try {
    const result = await client.query<DatabaseRoleResult>(`select
      not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='identity_workspace' and c.relname='workspace_preference'
        and c.relrowsecurity and c.relforcerowsecurity and not pg_has_role(current_user,c.relowner,'MEMBER'))
      or not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
        where n.nspname='identity_workspace' and p.proname='select_workspace_preference'
        and pg_get_function_identity_arguments(p.oid)='target text' and p.prosecdef
        and (r.rolsuper or r.rolbypassrls) and not pg_has_role(current_user,p.proowner,'MEMBER')
        and has_function_privilege(current_user,p.oid,'EXECUTE')) as unsafe`)
    if (!result.rows[0] || result.rows[0].unsafe)
      throw new Error(
        'Workspace selection requires isolated preference RLS and an explicitly granted privileged function',
      )
  } finally {
    client.release()
  }
}
