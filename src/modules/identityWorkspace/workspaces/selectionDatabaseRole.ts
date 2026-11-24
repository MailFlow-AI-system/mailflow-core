import type { DatabaseRoleResult, WorkspacePool } from './types.js'

export async function assertWorkspaceSelectionDatabaseRole(pool: WorkspacePool) {
  const client = await pool.connect()
  try {
    const result = await client.query<DatabaseRoleResult>(`select exists (
        select 1 from unnest(array['workspace_preference', 'workspace_handoff']) t(name)
        where not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='identity_workspace' and c.relname=t.name
          and c.relrowsecurity and c.relforcerowsecurity
          and not pg_has_role(current_user,c.relowner,'MEMBER'))
      ) or exists (
        select 1 from (values
          ('select_workspace_preference', 'target text'),
          ('issue_workspace_handoff', 'target text, code_hash text'),
          ('consume_workspace_handoff', 'code_hash text, host_slug text')
        ) f(name, args)
        where not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          join pg_roles r on r.oid=p.proowner
          where n.nspname='identity_workspace' and p.proname=f.name
          and pg_get_function_identity_arguments(p.oid)=f.args and p.prosecdef
          and (r.rolsuper or r.rolbypassrls) and not pg_has_role(current_user,p.proowner,'MEMBER')
          and has_function_privilege(current_user,p.oid,'EXECUTE'))
      ) as unsafe`)
    if (!result.rows[0] || result.rows[0].unsafe)
      throw new Error(
        'Workspace switching requires isolated preference and handoff RLS and explicitly granted privileged functions',
      )
  } finally {
    client.release()
  }
}
