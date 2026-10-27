import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import type { Client } from 'pg'

import { type MigrationModule, migrationModules, migrationTable } from './migrationModules.js'

type AppliedMigration = { hash: string; created_at: string }

export class MigrationLedgerMismatchError extends Error {
  readonly code = 'MIGRATION_LEDGER_MISMATCH'
  constructor(module: string) {
    super(`Migration ledger mismatch for ${module}`)
    this.name = 'MigrationLedgerMismatchError'
  }
}

export function loadModuleMigrations(module: MigrationModule) {
  return readMigrationFiles({
    migrationsFolder: fileURLToPath(
      new URL(`../../../database/migrations/${module.folder}/`, import.meta.url),
    ),
  })
}

// PR #24's destructive migration is recognized only if it was actually applied before reconciliation.
const legacyWorkspaceMigration = {
  hash: createHash('sha256')
    .update(
      readFileSync(
        new URL(
          '../../../database/migrations/mail/legacy/0001_workspace_inbox.sql',
          import.meta.url,
        ),
      ),
    )
    .digest('hex'),
  created_at: '1793025084417',
}

export function planMigrationHistory(
  module: MigrationModule,
  expected: MigrationMeta[],
  rows: AppliedMigration[],
  complete = false,
) {
  const mismatch = () => new MigrationLedgerMismatchError(module.name)
  if (
    expected.some(
      (migration, index) =>
        !Number.isSafeInteger(migration.folderMillis) ||
        (index > 0 && migration.folderMillis <= (expected[index - 1]?.folderMillis ?? 0)),
    ) ||
    new Set(expected.map((migration) => migration.hash)).size !== expected.length
  )
    throw mismatch()

  let applied = 0
  let legacySeen = false
  for (const row of rows) {
    if (
      module.name === 'mail' &&
      row.hash === legacyWorkspaceMigration.hash &&
      row.created_at === legacyWorkspaceMigration.created_at
    ) {
      if (
        legacySeen ||
        applied === 0 ||
        (expected[applied - 1]?.folderMillis ?? Infinity) >=
          Number(legacyWorkspaceMigration.created_at)
      )
        throw mismatch()
      legacySeen = true
      continue
    }
    const migration = expected[applied]
    if (
      !migration ||
      row.hash !== migration.hash ||
      row.created_at !== String(migration.folderMillis)
    )
      throw mismatch()
    applied++
  }
  if (complete && applied !== expected.length) throw mismatch()
  return expected.slice(applied)
}

export async function readAppliedMigrations(
  client: Pick<Client, 'query'>,
  module: MigrationModule,
  allowMissing = false,
) {
  const relation = `"${module.schema.replaceAll('"', '""')}"."${migrationTable.replaceAll('"', '""')}"`
  if (allowMissing) {
    const { rows } = await client.query<{ ledger: string | null }>(
      'SELECT to_regclass($1) AS ledger',
      [relation],
    )
    if (!rows[0]?.ledger) return []
  }
  const { rows } = await client.query<AppliedMigration>(
    `SELECT hash, created_at FROM ${relation} ORDER BY id`,
  )
  return rows
}

export async function verifyMigrationLedgers(client: Pick<Client, 'query'>) {
  for (const module of migrationModules) {
    planMigrationHistory(
      module,
      loadModuleMigrations(module),
      await readAppliedMigrations(client, module),
      true,
    )
  }
}
