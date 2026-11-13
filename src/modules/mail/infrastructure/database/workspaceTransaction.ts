import type { MailClient, MailPool } from '../../inbox/listMessages/types.js'

export async function inWorkspaceTransaction<T>(
  pool: MailPool,
  workspaceId: string,
  operation: (client: MailClient) => Promise<T>,
) {
  if (!workspaceId) throw new Error('A workspace is required')
  const client = await pool.connect()
  let releaseError: Error | undefined
  try {
    await client.query('BEGIN')
    await client.query("select set_config('mailflow.workspace_id', $1, true)", [workspaceId])
    const result = await operation(client)
    const commit = await client.query('COMMIT')
    if (commit.command !== 'COMMIT') throw new Error('Workspace transaction did not commit')
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

/** Also scopes per-user tables, whose RLS policies require `mailflow.user_id`. */
export function inUserWorkspaceTransaction<T>(
  pool: MailPool,
  workspaceId: string,
  userId: string,
  operation: (client: MailClient) => Promise<T>,
) {
  if (!userId) throw new Error('An authenticated identity is required')
  return inWorkspaceTransaction(pool, workspaceId, async (client) => {
    await client.query("select set_config('mailflow.user_id', $1, true)", [userId])
    return operation(client)
  })
}
