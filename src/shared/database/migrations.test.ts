import type { MigrationMeta } from 'drizzle-orm/migrator'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
  client: vi.fn(),
  readMigrationFiles: vi.fn(),
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
vi.mock('drizzle-orm/migrator', () => ({ readMigrationFiles: mocks.readMigrationFiles }))

import { runMigrations } from './migrations.js'

const environment = { DIRECT_URL: 'postgresql://migrator:password@localhost:5432/mailflow' }
const fixture = (name: string, timestamp: number): MigrationMeta => ({
  hash: `${name}-hash`,
  folderMillis: timestamp,
  sql: [`CREATE TABLE ${name} (id integer);`],
  bps: true,
})
const shipped = {
  identity_workspace_migrations: [fixture('identity_first', 1000), fixture('identity_next', 2000)],
  mail_migrations: [fixture('mail_first', 1000), fixture('mail_next', 2000)],
}
type Row = { hash: string; created_at: string }
let ledgers: Record<string, Row[]>

function relation(sql: string) {
  const schema = /"([^"]+)"\."__drizzle_migrations"/.exec(sql)?.[1]
  if (!schema) throw new Error('Expected test ledger relation')
  return schema
}
async function query(sql: string, values: unknown[] = []) {
  if (sql.startsWith('SELECT to_regclass')) {
    const schema = relation(String(values[0]))
    return { rows: [{ ledger: ledgers[schema] ? String(values[0]) : null }] }
  }
  if (sql.startsWith('SELECT hash')) return { rows: ledgers[relation(sql)] ?? [] }
  if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) ledgers[relation(sql)] ??= []
  if (sql.startsWith('INSERT INTO')) {
    ledgers[relation(sql)]?.push({ hash: String(values[0]), created_at: String(values[1]) })
  }
  return { rows: [] }
}

describe('runMigrations', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    ledgers = {}
    mocks.query.mockImplementation(query)
    mocks.readMigrationFiles.mockImplementation(
      ({ migrationsFolder }: { migrationsFolder: string }) =>
        migrationsFolder.endsWith('/identityWorkspace/')
          ? shipped.identity_workspace_migrations
          : shipped.mail_migrations,
    )
  })

  it('rejects divergence in a later module before any application SQL executes', async () => {
    ledgers.mail_migrations = [{ hash: 'unknown', created_at: '1794000000000' }]
    await expect(runMigrations(environment)).rejects.toThrow('Migration ledger mismatch for mail')
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).startsWith('CREATE TABLE'))).toBe(
      false,
    )
    expect(mocks.query.mock.calls.some(([sql]) => sql === 'BEGIN')).toBe(false)
    expect(mocks.end).toHaveBeenCalledOnce()
  })

  it('holds one session lock, applies Identity before Mail and verifies both complete histories', async () => {
    await runMigrations(environment)
    expect(mocks.client).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: environment.DIRECT_URL,
        connectionTimeoutMillis: 10000,
        statement_timeout: 120000,
        lock_timeout: 15000,
      }),
    )
    expect(mocks.query.mock.calls[0]).toEqual(['SELECT pg_advisory_lock($1)', [1296450119]])
    const application = mocks.query.mock.calls.filter(
      ([sql]) =>
        String(sql).startsWith('CREATE TABLE ') && !String(sql).startsWith('CREATE TABLE IF'),
    )
    expect(application.map(([sql]) => sql)).toEqual([
      'CREATE TABLE identity_first (id integer);',
      'CREATE TABLE identity_next (id integer);',
      'CREATE TABLE mail_first (id integer);',
      'CREATE TABLE mail_next (id integer);',
    ])
    expect(ledgers).toEqual(
      Object.fromEntries(
        Object.entries(shipped).map(([schema, entries]) => [
          schema,
          entries.map((entry) => ({ hash: entry.hash, created_at: String(entry.folderMillis) })),
        ]),
      ),
    )
    expect(mocks.end).toHaveBeenCalledOnce()
  })

  it.each([
    ['identity-workspace', 'identity_workspace_migrations'],
    ['mail', 'mail_migrations'],
  ])('validates and applies only selected module %s', async (name, schema) => {
    await runMigrations(environment, [name])
    expect(Object.keys(ledgers)).toEqual([schema])
  })

  it('does not reapply a complete valid history', async () => {
    await runMigrations(environment)
    mocks.query.mockClear()
    await runMigrations(environment)
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO'))).toBe(
      false,
    )
    expect(
      mocks.query.mock.calls.some(([sql]) => String(sql).startsWith('CREATE TABLE identity_first')),
    ).toBe(false)
  })

  it.each([['unknown'], ['mail', 'identity-workspace']])(
    'rejects invalid arguments before connecting: %s',
    async (...args) => {
      await expect(runMigrations(environment, args)).rejects.toThrow('migration target')
      expect(mocks.client).not.toHaveBeenCalled()
    },
  )

  it('requires DIRECT_URL even when DATABASE_URL exists', async () => {
    await expect(runMigrations({ DATABASE_URL: environment.DIRECT_URL })).rejects.toThrow(
      'DIRECT_URL',
    )
    expect(mocks.client).not.toHaveBeenCalled()
  })

  it('closes the session when connecting or locking fails', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('connection failed'))
    await expect(runMigrations(environment)).rejects.toThrow('connection failed')
    mocks.connect.mockResolvedValue(undefined)
    mocks.query.mockRejectedValueOnce(new Error('lock timeout'))
    await expect(runMigrations(environment)).rejects.toThrow('lock timeout')
    expect(mocks.end).toHaveBeenCalledTimes(2)
  })

  it('rolls back and stops when application SQL fails', async () => {
    mocks.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('CREATE TABLE identity_first')) throw new Error('SQL failed')
      return query(sql, values)
    })
    await expect(runMigrations(environment)).rejects.toThrow('SQL failed')
    expect(mocks.query).toHaveBeenCalledWith('ROLLBACK')
    expect(
      mocks.query.mock.calls.some(([sql]) => String(sql).startsWith('CREATE TABLE mail_first')),
    ).toBe(false)
    expect(mocks.end).toHaveBeenCalledOnce()
  })

  it('fails and rolls back if the final ledger does not contain the executed migration', async () => {
    mocks.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('INSERT INTO')) return { rows: [] }
      return query(sql, values)
    })
    await expect(runMigrations(environment)).rejects.toThrow('Migration ledger mismatch')
    expect(mocks.query).toHaveBeenCalledWith('ROLLBACK')
    expect(mocks.query).not.toHaveBeenCalledWith('COMMIT')
  })

  it('rechecks all selected ledgers after a later module runs', async () => {
    mocks.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      const result = await query(sql, values)
      if (sql.startsWith('CREATE TABLE mail_first')) {
        const initial = ledgers.identity_workspace_migrations?.[0]
        if (initial) initial.hash = 'tampered-during-later-module'
      }
      return result
    })
    await expect(runMigrations(environment)).rejects.toThrow(
      'Migration ledger mismatch for identity-workspace',
    )
  })

  it('reports completion only after verification without logging credentials', async () => {
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
