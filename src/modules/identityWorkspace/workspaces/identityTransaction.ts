import type { WorkspaceClient, WorkspacePool } from './types.js'

export async function inIdentityTransaction<T>(
  pool: WorkspacePool,
  userId: string,
  operation: (client: WorkspaceClient) => Promise<T>,
) {
  if (!userId) throw new Error('An authenticated identity is required')
  const client = await pool.connect()
  let releaseError: Error | undefined
  try {
    await client.query('BEGIN')
    await client.query("select set_config('mailflow.user_id', $1, true)", [userId])
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (cleanupError) {
      // Never return a connection with unverified transaction context to the pool.
      releaseError = cleanupError instanceof Error ? cleanupError : new Error('Rollback failed')
    }
    throw error
  } finally {
    client.release(releaseError)
  }
}
