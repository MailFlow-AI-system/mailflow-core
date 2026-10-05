import type { Pool } from 'pg'
import { assertWorkspaceDatabaseRole } from '../workspaces/databaseRole.js'
import type { RoleSafetyRow } from './types.js'

export async function assertOnboardingDatabaseRole(pool: Pool) {
  await assertWorkspaceDatabaseRole(pool)
  const result = await pool.query<RoleSafetyRow>(`select count(*) <> 2 or coalesce(bool_or(
    pg_has_role(current_user, c.relowner, 'MEMBER') or not c.relrowsecurity or not c.relforcerowsecurity), true) as unsafe
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'identity_workspace' and c.relname in ('onboarding_signup', 'onboarding_email')`)
  if (result.rows[0]?.unsafe !== false)
    throw new Error('Onboarding requires migrated FORCE RLS tables and a non-owner role')
}
