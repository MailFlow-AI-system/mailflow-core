import { describe, expect, it, vi } from 'vitest'
import { inWorkspaceTransaction } from './workspaceTransaction.js'

describe('mail workspace transactions', () => {
  it('rejects empty context before acquiring a connection', async () => {
    const pool = { connect: vi.fn() }
    await expect(inWorkspaceTransaction(pool, '', async () => null)).rejects.toThrow('workspace')
    expect(pool.connect).not.toHaveBeenCalled()
  })
  it('does not report success when COMMIT returns ROLLBACK', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], command: 'ROLLBACK' })
    const release = vi.fn()
    await expect(
      inWorkspaceTransaction(
        { connect: vi.fn().mockResolvedValue({ query, release }) },
        'a',
        async () => 'result',
      ),
    ).rejects.toThrow('did not commit')
    expect(query).toHaveBeenCalledWith('ROLLBACK')
    expect(release).toHaveBeenCalledWith(undefined)
  })
  it('discards a connection when rollback fails and preserves the original failure', async () => {
    const cleanupError = new Error('rollback failed')
    const query = vi.fn(async (sql: string) => {
      if (sql === 'ROLLBACK') throw cleanupError
      return { rows: [] }
    })
    const release = vi.fn()
    await expect(
      inWorkspaceTransaction(
        { connect: vi.fn().mockResolvedValue({ query, release }) },
        'a',
        async () => {
          throw new Error('operation failed')
        },
      ),
    ).rejects.toThrow('operation failed')
    expect(release).toHaveBeenCalledWith(cleanupError)
  })
})
