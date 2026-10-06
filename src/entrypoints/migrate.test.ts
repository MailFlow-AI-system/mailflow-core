import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { runMigrations } from '../shared/database/migrations.js'

const mocks = vi.hoisted(() => ({ runMigrations: vi.fn<typeof runMigrations>() }))

vi.mock('../shared/database/migrations.js', () => ({ runMigrations: mocks.runMigrations }))

describe('migration command diagnostics', () => {
  const originalExitCode = process.exitCode

  beforeEach(() => {
    vi.resetModules()
    mocks.runMigrations.mockReset()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    process.exitCode = undefined
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    vi.restoreAllMocks()
  })

  it('reports nested PostgreSQL SQLSTATE and the failing module without exposing SQL data', async () => {
    const secret = 'postgresql://migrator:private-password@database:5432/mailflow'
    const databaseError = Object.assign(new Error(`SQL failed: ${secret}`), {
      code: '42P01',
      query: `SELECT '${secret}'`,
      parameters: [secret],
    })
    const error = new Error(`Failed query: ${secret}`, {
      cause: new Error('Driver wrapper', { cause: databaseError }),
    })
    mocks.runMigrations.mockImplementation(async (_environment, _args, log) => {
      log?.('Migration started', { module: 'mail' })
      throw error
    })

    await import('./migrate.js')

    expect(process.exitCode).toBe(1)
    expect(console.error).toHaveBeenCalledOnce()
    expect(JSON.parse(vi.mocked(console.error).mock.calls[0]?.[0] as string)).toMatchObject({
      errorCode: '42P01',
      module: 'mail',
      stage: 'migration',
    })
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret)
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(secret)
  })

  it('reports setup failure when no module started and no SQLSTATE is available', async () => {
    mocks.runMigrations.mockRejectedValue(undefined)

    await import('./migrate.js')

    expect(process.exitCode).toBe(1)
    const failure = JSON.parse(vi.mocked(console.error).mock.calls[0]?.[0] as string)
    expect(failure).toMatchObject({ stage: 'setup' })
    expect(failure).not.toHaveProperty('errorCode')
    expect(failure).not.toHaveProperty('module')
  })

  it('rejects arbitrary error metadata while finding a nested SQLSTATE', async () => {
    const secret = 'postgresql://migrator:private-password@database:5432/mailflow'
    mocks.runMigrations.mockRejectedValue({
      name: secret,
      code: secret,
      cause: { code: '23505' },
    })

    await import('./migrate.js')

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(vi.mocked(console.error).mock.calls[0]?.[0] as string)).toMatchObject({
      errorCode: '23505',
    })
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret)
  })

  it('terminates cause traversal when the error chain contains a cycle', async () => {
    const failure: { cause?: unknown } = {}
    failure.cause = failure
    mocks.runMigrations.mockRejectedValue(failure)

    await import('./migrate.js')

    expect(process.exitCode).toBe(1)
    expect(console.error).toHaveBeenCalledOnce()
    expect(JSON.parse(vi.mocked(console.error).mock.calls[0]?.[0] as string)).not.toHaveProperty(
      'errorCode',
    )
  })

  it('preserves safe operational codes and error names for connection failures', async () => {
    mocks.runMigrations.mockRejectedValue(
      Object.assign(new TypeError('Connection refused'), { code: 'ECONNREFUSED' }),
    )

    await import('./migrate.js')

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(vi.mocked(console.error).mock.calls[0]?.[0] as string)).toMatchObject({
      errorName: 'TypeError',
      errorCode: 'ECONNREFUSED',
      stage: 'setup',
    })
  })

  it('prefers the underlying SQLSTATE over a safe wrapper code', async () => {
    mocks.runMigrations.mockRejectedValue({
      code: 'QUERY_FAILED',
      cause: { code: '42501' },
    })

    await import('./migrate.js')

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(vi.mocked(console.error).mock.calls[0]?.[0] as string)).toMatchObject({
      errorCode: '42501',
    })
  })

  it('reports connection cleanup failure after the last module completes', async () => {
    mocks.runMigrations.mockImplementation(async (_environment, _args, log) => {
      log?.('Migration started', { module: 'mail' })
      log?.('Migration completed', { module: 'mail' })
      throw new Error('Connection close failed')
    })

    await import('./migrate.js')

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(vi.mocked(console.error).mock.calls[0]?.[0] as string)).toMatchObject({
      module: 'mail',
      stage: 'cleanup',
    })
  })

  it('preserves progress logs and succeeds without setting an error exit code', async () => {
    mocks.runMigrations.mockImplementation(async (_environment, _args, log) => {
      log?.('Migration started', { module: 'mail' })
      log?.('Migration completed', { module: 'mail' })
    })

    await import('./migrate.js')

    expect(mocks.runMigrations).toHaveBeenCalledWith(
      process.env,
      process.argv.slice(2),
      expect.any(Function),
    )
    expect(console.info).toHaveBeenCalledWith(
      JSON.stringify({ message: 'Migration completed', module: 'mail' }),
    )
    expect(console.error).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })
})
