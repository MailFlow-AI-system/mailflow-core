import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'

import { createDatabase } from './client.js'

describe('database client', () => {
  it('reports idle pool errors through the provided logger', async () => {
    const errorLogger = vi.fn()
    const logger = { error: errorLogger } as unknown as Pick<Logger, 'error'>
    const database = createDatabase('postgresql://user:password@localhost/mailflow', logger)

    try {
      const poolError = Object.assign(
        new Error(
          'Simulated idle PostgreSQL connection failure: postgresql://user:secret-password@db.internal/mailflow',
        ),
        { code: 'ECONNRESET' },
      )
      database.pool.emit('error', poolError)

      expect(errorLogger).toHaveBeenCalledOnce()
      const [context, message] = errorLogger.mock.calls[0] as [Record<string, unknown>, string]
      expect(message).toBe('Database pool error')
      expect(context).toMatchObject({
        errorName: 'Error',
        errorCode: 'ECONNRESET',
      })
      expect(context).not.toHaveProperty('errorMessage')
      expect(JSON.stringify(errorLogger.mock.calls)).not.toContain('secret-password')
    } finally {
      await database.pool.end()
    }
  })
})
