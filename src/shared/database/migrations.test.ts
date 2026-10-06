import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
  client: vi.fn(),
  migrate: vi.fn(),
  drizzle: vi.fn(),
}))

vi.mock('pg', () => ({
  Client: class {
    connect = mocks.connect
    query = mocks.query
    end = mocks.end
    on = mocks.on
    constructor(options: unknown) {
      mocks.client(options)
    }
  },
}))
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: mocks.drizzle }))
vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate: mocks.migrate }))

import { runMigrations } from './migrations.js'

const environment = { DIRECT_URL: 'postgresql://migrator:password@localhost:5432/mailflow' }

describe('runMigrations', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.connect.mockResolvedValue(undefined)
    mocks.query.mockResolvedValue({ rows: [] })
    mocks.end.mockResolvedValue(undefined)
    mocks.migrate.mockResolvedValue(undefined)
    mocks.drizzle.mockReturnValue({ database: true })
  })

  it('holds a session lock and applies identity before mail on the same connection', async () => {
    await runMigrations(environment)

    expect(mocks.client).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: environment.DIRECT_URL,
        connectionTimeoutMillis: 10_000,
        statement_timeout: 120_000,
        lock_timeout: 15_000,
      }),
    )
    expect(mocks.query).toHaveBeenCalledWith('SELECT pg_advisory_lock($1)', expect.any(Array))
    expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.migrate.mock.invocationCallOrder[0] ?? 0,
    )
    expect(mocks.migrate.mock.calls.map(([, config]) => config.migrationsSchema)).toEqual([
      'identity_workspace_migrations',
      'mail_migrations',
    ])
    for (const [database, config] of mocks.migrate.mock.calls) {
      expect(database).toEqual({ database: true })
      expect(config).toMatchObject({ migrationsTable: '__drizzle_migrations' })
      expect(config.migrationsFolder).toContain('/database/migrations/')
    }
    expect(mocks.drizzle).toHaveBeenCalledOnce()
    expect(mocks.end).toHaveBeenCalledOnce()
    expect(mocks.end.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.migrate.mock.invocationCallOrder[1] ?? 0,
    )
  })

  it.each([
    ['identity-workspace', 'identity_workspace_migrations'],
    ['mail', 'mail_migrations'],
  ])('runs only the selected module %s', async (target, schema) => {
    await runMigrations(environment, [target])
    expect(mocks.migrate).toHaveBeenCalledOnce()
    expect(mocks.migrate.mock.calls[0]?.[1].migrationsSchema).toBe(schema)
  })

  it.each([['unknown'], ['mail', 'identity-workspace']])(
    'rejects invalid arguments before connecting: %s',
    async (...args) => {
      await expect(runMigrations(environment, args)).rejects.toThrow('migration target')
      expect(mocks.client).not.toHaveBeenCalled()
    },
  )

  it('rejects missing DIRECT_URL before connecting even with DATABASE_URL', async () => {
    await expect(runMigrations({ DATABASE_URL: environment.DIRECT_URL })).rejects.toThrow(
      'DIRECT_URL',
    )
    expect(mocks.client).not.toHaveBeenCalled()
  })

  it('closes the connection when connecting fails', async () => {
    mocks.connect.mockRejectedValue(new Error('connection failed'))
    await expect(runMigrations(environment)).rejects.toThrow('connection failed')
    expect(mocks.migrate).not.toHaveBeenCalled()
    expect(mocks.end).toHaveBeenCalledOnce()
  })

  it('does not migrate when the session lock cannot be acquired', async () => {
    mocks.query.mockRejectedValue(new Error('lock timeout'))
    await expect(runMigrations(environment)).rejects.toThrow('lock timeout')
    expect(mocks.migrate).not.toHaveBeenCalled()
    expect(mocks.end).toHaveBeenCalledOnce()
  })

  it('stops on migration failure and closes the connection to release the lock', async () => {
    mocks.migrate.mockRejectedValueOnce(new Error('SQL failed'))
    await expect(runMigrations(environment)).rejects.toThrow('SQL failed')
    expect(mocks.migrate).toHaveBeenCalledOnce()
    expect(mocks.end).toHaveBeenCalledOnce()
  })

  it('reports module completion without logging connection credentials', async () => {
    const log = vi.fn()
    await runMigrations(environment, [], log)
    expect(log.mock.calls).toEqual([
      ['Migration started', { module: 'identity-workspace' }],
      ['Migration completed', { module: 'identity-workspace' }],
      ['Migration started', { module: 'mail' }],
      ['Migration completed', { module: 'mail' }],
    ])
    expect(JSON.stringify(log.mock.calls)).not.toContain('password')
  })
})
