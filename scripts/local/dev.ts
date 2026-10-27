import { Pool } from 'pg'
import { assertWorkspaceDatabaseRole } from '../../src/modules/identityWorkspace/workspaces/databaseRole.js'
import { assertWorkspaceSelectionDatabaseRole } from '../../src/modules/identityWorkspace/workspaces/selectionDatabaseRole.js'
import { assertMailDatabaseRole } from '../../src/modules/mail/infrastructure/database/databaseRole.js'
import { localDevelopmentEnvironment } from '../../src/shared/config/localDevelopment.js'

const environment = localDevelopmentEnvironment(process.env, true)
if (environment.WORKSPACE_READ_ENABLED === 'true') {
  const pool = new Pool({ connectionString: environment.DATABASE_URL })
  try {
    await assertWorkspaceDatabaseRole(pool)
    await assertWorkspaceSelectionDatabaseRole(pool)
    await assertMailDatabaseRole(pool)
    await pool.query('SELECT workspace_id FROM mail.message LIMIT 0')
    await pool.query('SELECT delivery_state, attempt_token FROM mail.outgoing_email LIMIT 0')
  } catch (error) {
    throw new Error(
      'Local workspace prerequisites failed. Use a restricted DATABASE_URL with current migrations; keep DIRECT_URL for the deployment migration pipeline. No migrations or grants were changed.',
      { cause: error },
    )
  } finally {
    await pool.end()
  }
}
Object.assign(process.env, environment)
await import('../../src/entrypoints/api.js')
