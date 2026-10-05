import { describe, expect, it, vi } from 'vitest'
import { inIdentityTransaction } from './identityTransaction.js'
import { createWorkspaceReader } from './workspaceReader.js'

describe('authorized workspace discovery', () => {
  it('does not report success when PostgreSQL rolls back instead of committing', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], command: 'ROLLBACK' })
    const release = vi.fn()
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) }
    await expect(inIdentityTransaction(pool, 'user-a', async () => 'selected')).rejects.toThrow(
      'did not commit',
    )
  })
  it('destroys a connection if rollback cannot clear its identity context', async () => {
    const cleanupError = new Error('connection cleanup failed')
    const query = vi.fn(async (sql: string) => {
      if (sql === 'ROLLBACK') throw cleanupError
      return { rows: [] }
    })
    const release = vi.fn()
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) }
    await expect(
      inIdentityTransaction(pool, 'user-a', async () => {
        throw new Error('operation failed')
      }),
    ).rejects.toThrow('operation failed')
    expect(release).toHaveBeenCalledWith(cleanupError)
  })
  it('never resolves a missing membership as a different workspace', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], command: 'COMMIT' })
    const release = vi.fn()
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) }
    const reader = createWorkspaceReader(pool)

    await expect(reader.context('user-a', 'unknown')).resolves.toBeNull()
    expect(query).toHaveBeenCalledWith("select set_config('mailflow.user_id', $1, true)", [
      'user-a',
    ])
    expect(query).toHaveBeenCalledWith('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })
})
