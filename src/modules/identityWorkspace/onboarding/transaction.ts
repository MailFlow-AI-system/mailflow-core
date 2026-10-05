import type { Pool, PoolClient } from 'pg'

export async function inOnboardingTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect()
  let releaseError: Error | undefined
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    const commit = await client.query('COMMIT')
    if (commit.command !== 'COMMIT') throw new Error('Onboarding transaction did not commit')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (cleanupError) {
      releaseError = cleanupError instanceof Error ? cleanupError : new Error('Rollback failed')
    }
    throw error
  } finally {
    client.release(releaseError)
  }
}
