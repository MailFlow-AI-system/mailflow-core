import { Client } from 'pg'

import { loadMigrationConfig } from '../shared/database/migrationConfig.js'
import {
  MigrationLedgerMismatchError,
  verifyMigrationLedgers,
} from '../shared/database/migrationLedgers.js'

const { directUrl } = loadMigrationConfig(process.env)
const client = new Client({
  connectionString: directUrl,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
})
try {
  await client.connect()
  await verifyMigrationLedgers(client)
  console.info('Migration ledgers match shipped journals')
} catch (error) {
  console.error(
    error instanceof MigrationLedgerMismatchError
      ? error.message
      : 'Migration ledger verification failed',
  )
  process.exitCode = 1
} finally {
  await client.end()
}
