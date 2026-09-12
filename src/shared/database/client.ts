import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import type { Logger } from 'pino'

type DatabaseLogger = Pick<Logger, 'error'>
type DatabasePoolError = Error & { code?: string }

export function createDatabase(databaseUrl: string, logger: DatabaseLogger) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
    statement_timeout: 2_000,
  })

  pool.on('error', (error: DatabasePoolError) => {
    logger.error(
      {
        errorName: error.name,
        ...(error.code === undefined ? {} : { errorCode: error.code }),
      },
      'Database pool error',
    )
  })

  return {
    database: drizzle({ client: pool }),
    pool,
    check: async () => {
      await pool.query('select 1')
    },
  }
}
