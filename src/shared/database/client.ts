import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

export function createDatabase(databaseUrl: string) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
    statement_timeout: 2_000,
  })

  return {
    database: drizzle({ client: pool }),
    pool,
    check: async () => {
      await pool.query('select 1')
    },
  }
}
