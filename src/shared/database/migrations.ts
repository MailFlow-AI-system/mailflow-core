import { Client } from 'pg'

import { loadMigrationConfig } from './migrationConfig.js'
import {
  loadModuleMigrations,
  planMigrationHistory,
  readAppliedMigrations,
} from './migrationLedgers.js'
import { migrationModules, migrationTable } from './migrationModules.js'

type MigrationLog = (message: string, context: { module: string }) => void

export async function runMigrations(
  environment: NodeJS.ProcessEnv,
  args: readonly string[] = [],
  log: MigrationLog = () => undefined,
) {
  const { directUrl } = loadMigrationConfig(environment)
  const selected =
    args.length === 0
      ? migrationModules
      : migrationModules.filter((module) => module.name === args[0])
  if (args.length > 1 || selected.length === 0) {
    const validTargets = migrationModules.map((module) => module.name).join(', ')
    throw new Error(`Invalid migration target; use ${validTargets}, or no target for all`)
  }
  const shipped = selected.map((module) => ({ module, expected: loadModuleMigrations(module) }))
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
    // Session-scoped: all modules and transactions use the same direct connection.
    await client.query('SELECT pg_advisory_lock($1)', [1_296_450_119])
    const plans = []
    // Validate every selected ledger before any module can change application data.
    for (const { module, expected } of shipped) {
      const applied = await readAppliedMigrations(client, module, true)
      plans.push({ module, expected, pending: planMigrationHistory(module, expected, applied) })
    }
    for (const { module, expected, pending } of plans) {
      log('Migration started', { module: module.name })
      const schema = `"${module.schema.replaceAll('"', '""')}"`
      const table = `${schema}."${migrationTable.replaceAll('"', '""')}"`
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
      )
      await client.query('BEGIN')
      try {
        for (const migration of pending) {
          for (const statement of migration.sql) {
            if (statement.trim()) await client.query(statement)
          }
          await client.query(`INSERT INTO ${table} (hash, created_at) VALUES ($1, $2)`, [
            migration.hash,
            migration.folderMillis,
          ])
        }
        planMigrationHistory(module, expected, await readAppliedMigrations(client, module), true)
        if (connectionError) throw connectionError
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
      log('Migration completed', { module: module.name })
    }
    for (const { module, expected } of plans) {
      planMigrationHistory(module, expected, await readAppliedMigrations(client, module), true)
    }
  } finally {
    // Closing the session releases its advisory lock, including after rollback or failure.
    await client.end()
  }
}
