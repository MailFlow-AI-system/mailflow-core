import { describe, expect, it, vi } from 'vitest'

import { createHealthModule } from './route.js'

describe('health module', () => {
  it('reports process liveness without checking dependencies', async () => {
    const checkDatabase = vi.fn()
    const app = createHealthModule({ checkDatabase })

    const response = await app.request('/health/live')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(checkDatabase).not.toHaveBeenCalled()
  })

  it('reports readiness when PostgreSQL is reachable', async () => {
    const checkDatabase = vi.fn().mockResolvedValue(undefined)
    const app = createHealthModule({ checkDatabase })

    const response = await app.request('/health/ready')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ready',
      checks: { database: 'up' },
    })
    expect(checkDatabase).toHaveBeenCalledOnce()
  })

  it('reports unavailability without exposing the database error', async () => {
    const checkDatabase = vi.fn().mockRejectedValue(new Error('secret connection details'))
    const app = createHealthModule({ checkDatabase })

    const response = await app.request('/health/ready')
    const responseBody = await response.text()

    expect(response.status).toBe(503)
    expect(JSON.parse(responseBody)).toEqual({
      status: 'not_ready',
      checks: { database: 'down' },
    })
    expect(responseBody).not.toContain('secret connection details')
  })
})
