import { describe, expect, it, vi } from 'vitest'

import { flushLogger } from './logger.js'

describe('logger lifecycle', () => {
  it('waits for Pino flush before process telemetry shutdown', async () => {
    const flush = vi.fn((callback: () => void) => callback())

    await flushLogger({ flush })

    expect(flush).toHaveBeenCalledOnce()
  })
})
