import type { MailPool } from '../../inbox/listMessages/types.js'

export async function assertMailDatabaseRole(pool: MailPool) {
  const client = await pool.connect()
  try {
    const result = await client.query<{ unsafe: boolean }>(`select
      r.rolsuper or r.rolbypassrls or not exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'mail' and c.relname = 'message'
          and c.relrowsecurity and c.relforcerowsecurity
          and not pg_has_role(current_user, c.relowner, 'MEMBER')
      ) as unsafe from pg_roles r where r.rolname = current_user`)
    if (!result.rows[0] || result.rows[0].unsafe)
      throw new Error(
        'Mail access requires FORCE RLS and a non-owner role without SUPERUSER or BYPASSRLS',
      )
  } finally {
    client.release()
  }
}
