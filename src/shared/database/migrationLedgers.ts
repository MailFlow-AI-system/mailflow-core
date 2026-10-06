import { fileURLToPath } from 'node:url'

import { readMigrationFiles } from 'drizzle-orm/migrator'
import type { Client } from 'pg'

import { migrationModules, migrationTable } from './migrationModules.js'

export class MigrationLedgerMismatchError extends Error {
  constructor(module: string) {
    super(`Migration ledger mismatch for ${module}`)
    this.name = 'MigrationLedgerMismatchError'
  }
}

export async function verifyMigrationLedgers(client: Pick<Client, 'query'>) {
  for (const module of migrationModules) {
    const expected = readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL(`../../../database/migrations/${module.folder}/`, import.meta.url),
      ),
    })
    const schema = module.schema.replaceAll('"', '""')
    const table = migrationTable.replaceAll('"', '""')
    const { rows } = await client.query<{ hash: string; created_at: string }>(
      `SELECT hash, created_at FROM "${schema}"."${table}" ORDER BY created_at`,
    )
    if (
      rows.length !== expected.length ||
      expected.some(
        (migration, index) =>
          rows[index]?.hash !== migration.hash ||
          rows[index]?.created_at !== String(migration.folderMillis),
      )
    ) {
      throw new MigrationLedgerMismatchError(module.name)
    }
  }
}
