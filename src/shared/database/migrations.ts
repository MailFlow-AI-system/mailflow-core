import { fileURLToPath } from 'node:url'

import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Client } from 'pg'

import { loadMigrationConfig } from './migrationConfig.js'

const modules = [
  {
    name: 'identity-workspace',
    folder: 'identityWorkspace',
    schema: 'identity_workspace_migrations',
  },
  { name: 'mail', folder: 'mail', schema: 'mail_migrations' },
] as const

type MigrationLog = (message: string, context: { module: string }) => void

export async function runMigrations(
  environment: NodeJS.ProcessEnv,
  args: readonly string[] = [],
  log: MigrationLog = () => undefined,
) {
  const { directUrl } = loadMigrationConfig(environment)
  const selected = args.length === 0 ? modules : modules.filter((module) => module.name === args[0])
  if (args.length > 1 || selected.length === 0) {
    throw new Error('Invalid migration target; use identity-workspace, mail, or no target for all')
  }

  const client = new Client({
    connectionString: directUrl,
    application_name: 'mailflow-core-migrations',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000,
    lock_timeout: 15_000,
  })
  let connectionError: Error | undefined
  client.on('error', (error: Error) => {
    connectionError = error
  })

  try {
    await client.connect()
    // Session-scoped: all modules and their transactions use this same direct connection.
    await client.query('SELECT pg_advisory_lock($1)', [1_296_450_119])
    const database = drizzle({ client })
    for (const module of selected) {
      log('Migration started', { module: module.name })
      await migrate(database, {
        migrationsFolder: fileURLToPath(
          new URL(`../../../database/migrations/${module.folder}/`, import.meta.url),
        ),
        migrationsSchema: module.schema,
        migrationsTable: '__drizzle_migrations',
      })
      if (connectionError) throw connectionError
      log('Migration completed', { module: module.name })
    }
  } finally {
    // Closing the session also releases its advisory lock, including after rollback or failure.
    await client.end()
  }
}
