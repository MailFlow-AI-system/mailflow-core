import type { MigrationMeta } from 'drizzle-orm/migrator'
import type { Client } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { planMigrationHistory, verifyMigrationLedgers } from './migrationLedgers.js'
import { migrationModules } from './migrationModules.js'

const mocks = vi.hoisted(() => ({ readMigrationFiles: vi.fn() }))
vi.mock('drizzle-orm/migrator', () => mocks)

const initialMigration: MigrationMeta = {
  hash: 'first-sql-hash',
  folderMillis: 1_000,
  sql: ['CREATE TABLE example (id integer);'],
  bps: true,
}
const initialRow = { hash: initialMigration.hash, created_at: '1000' }

function clientWithRows(rows: { hash: string; created_at: string }[]) {
  const query = vi.fn().mockResolvedValue({ rows })
  return { query } as unknown as Pick<Client, 'query'>
}

describe('migration ledger verification', () => {
  beforeEach(() => {
    mocks.readMigrationFiles.mockReset()
    mocks.readMigrationFiles.mockReturnValue([initialMigration])
  })

  it('accepts ledger hashes and timestamps matching the shipped journal', async () => {
    const client = clientWithRows([initialRow])
    await expect(verifyMigrationLedgers(client)).resolves.toBeUndefined()
    expect(client.query).toHaveBeenCalledTimes(migrationModules.length)
  })

  it('accepts a new shipped migration without changing an expected count', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'migration-ledger-'))
    const { readMigrationFiles } =
      await vi.importActual<typeof import('drizzle-orm/migrator')>('drizzle-orm/migrator')
    try {
      mkdirSync(join(directory, 'meta'))
      const rows = [1_000, 2_000].map((when, index) => {
        const tag = `000${index}_example`
        const sql = `CREATE TABLE example_${index} (id integer);`
        writeFileSync(join(directory, `${tag}.sql`), sql)
        return { hash: createHash('sha256').update(sql).digest('hex'), created_at: String(when) }
      })
      writeFileSync(
        join(directory, 'meta/_journal.json'),
        JSON.stringify({
          version: '7',
          dialect: 'postgresql',
          entries: [1_000, 2_000].map((when, idx) => ({
            idx,
            version: '7',
            when,
            tag: `000${idx}_example`,
            breakpoints: true,
          })),
        }),
      )
      mocks.readMigrationFiles.mockImplementation(() =>
        readMigrationFiles({ migrationsFolder: directory }),
      )
      const client = clientWithRows(rows)
      await expect(verifyMigrationLedgers(client)).resolves.toBeUndefined()
      expect(client.query).toHaveBeenCalledTimes(migrationModules.length)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['missing migration', []],
    ['extra migration', [initialRow, { hash: 'extra-sql-hash', created_at: '2000' }]],
    ['wrong hash', [{ ...initialRow, hash: 'different-sql-hash' }]],
    ['wrong timestamp', [{ ...initialRow, created_at: '999' }]],
  ])('rejects a ledger with a %s', async (_description, rows) => {
    await expect(verifyMigrationLedgers(clientWithRows(rows))).rejects.toThrow(
      'Migration ledger mismatch for identity-workspace',
    )
  })

  it.each([
    ['duplicate hash', [initialRow, initialRow]],
    ['missing prefix', [{ hash: 'second-sql-hash', created_at: '2000' }]],
    ['out-of-order history', [{ hash: 'second-sql-hash', created_at: '2000' }, initialRow]],
    ['timestamp collision', [initialRow, { hash: 'second-sql-hash', created_at: '1000' }]],
  ])('rejects %s before planning any missing migrations', (_description, rows) => {
    const next: MigrationMeta = { ...initialMigration, hash: 'second-sql-hash', folderMillis: 2000 }
    expect(() => planMigrationHistory(migrationModules[0], [initialMigration, next], rows)).toThrow(
      'Migration ledger mismatch',
    )
  })

  it.each([
    [
      { ...initialMigration, folderMillis: 2000 },
      { ...initialMigration, hash: 'second', folderMillis: 1000 },
    ],
    [initialMigration, { ...initialMigration, folderMillis: 2000 }],
    [initialMigration, { ...initialMigration, hash: 'second', folderMillis: 1000 }],
  ])('rejects malformed shipped journal order or duplicate SQL hashes', (...expected) => {
    expect(() => planMigrationHistory(migrationModules[0], expected, [])).toThrow(
      'Migration ledger mismatch',
    )
  })

  it('recognizes only the exact already-applied PR24 migration without scheduling its destructive SQL', async () => {
    const { readMigrationFiles } =
      await vi.importActual<typeof import('drizzle-orm/migrator')>('drizzle-orm/migrator')
    const expected = readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL('../../../database/migrations/mail/', import.meta.url),
      ),
    })
    const module = migrationModules.find((item) => item.name === 'mail')
    if (!module) throw new Error('Missing Mail module')
    const legacy = {
      hash: '266b5ab949c37662c81d8e41be47c2a600d1868d92616632606c69635f10cc36',
      created_at: '1793025084417',
    }
    const first = expected[0]
    if (!first) throw new Error('Missing initial Mail migration')
    const firstRow = { hash: first.hash, created_at: String(first.folderMillis) }
    const previous = [firstRow, legacy]
    const pending = planMigrationHistory(module, expected, previous)
    expect(pending).toEqual(expected.slice(1))
    expect(pending.some((entry) => entry.hash === legacy.hash)).toBe(false)
    const complete = [
      ...previous,
      ...expected
        .slice(1)
        .map((entry) => ({ hash: entry.hash, created_at: String(entry.folderMillis) })),
    ]
    expect(planMigrationHistory(module, expected, complete, true)).toEqual([])
    expect(() => planMigrationHistory(module, expected, [...previous, legacy])).toThrow(
      'Migration ledger mismatch',
    )
    expect(() =>
      planMigrationHistory(module, expected, [
        firstRow,
        { ...legacy, created_at: '1793025084418' },
      ]),
    ).toThrow('Migration ledger mismatch')
  })

  it('recognizes PR24 applied after an older Send prefix but rejects it after newer storage migrations', async () => {
    const { readMigrationFiles } =
      await vi.importActual<typeof import('drizzle-orm/migrator')>('drizzle-orm/migrator')
    const expected = readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL('../../../database/migrations/mail/', import.meta.url),
      ),
    })
    const module = migrationModules.find((item) => item.name === 'mail')
    if (!module) throw new Error('Missing Mail module')
    const legacy = {
      hash: '266b5ab949c37662c81d8e41be47c2a600d1868d92616632606c69635f10cc36',
      created_at: '1793025084417',
    }
    const rows = expected
      .slice(0, 3)
      .map((entry) => ({ hash: entry.hash, created_at: String(entry.folderMillis) }))
    expect(planMigrationHistory(module, expected, [...rows, legacy])).toEqual(expected.slice(3))
    const newer = expected
      .slice(0, 4)
      .map((entry) => ({ hash: entry.hash, created_at: String(entry.folderMillis) }))
    expect(() => planMigrationHistory(module, expected, [...newer, legacy])).toThrow(
      'Migration ledger mismatch',
    )
  })

  it('preserves the six already-applied Send migration hashes and timestamps', async () => {
    const { readMigrationFiles } =
      await vi.importActual<typeof import('drizzle-orm/migrator')>('drizzle-orm/migrator')
    const expected = readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL('../../../database/migrations/mail/', import.meta.url),
      ),
    })
    expect(expected.slice(0, 6).map((entry) => [entry.hash, entry.folderMillis])).toEqual([
      ['e98e4a1e03a8e27991a1d51bb9ce20f9563382990c7b75242678c90477291dfe', 1790883059340],
      ['1a568ff1e46ba4a66d03c92a0439e112bd3957f91c4a50ba678fcffce456da03', 1793016657678],
      ['1217f1f47afa325614328eb43da9eefaed3f477b4ad47103fd2236790edf8dbe', 1793023574403],
      ['a070ee46b6c360d65699b00641f442d901c6dc4f21ca893f8eafe6690af256c4', 1793051619709],
      ['9c6f7a03ce4b7aa11398ad9cb032a6fee5416a1e7be811e3cb1416cac1102c4b', 1793054225375],
      ['ab52cd43e5ec7e390eb065903d92ad32a48bb6b0d7be6acee10aec878500eef7', 1793066348738],
    ])
  })

  it('propagates a missing ledger or another database failure', async () => {
    const failure = new Error('relation does not exist')
    const client = { query: vi.fn().mockRejectedValue(failure) } as unknown as Pick<Client, 'query'>
    await expect(verifyMigrationLedgers(client)).rejects.toBe(failure)
  })

  it('rejects a mismatch in a later registered module', async () => {
    const query = vi.fn()
    for (const [index] of migrationModules.entries()) {
      query.mockResolvedValueOnce({
        rows: index === migrationModules.length - 1 ? [] : [initialRow],
      })
    }
    const client = { query } as unknown as Pick<Client, 'query'>
    await expect(verifyMigrationLedgers(client)).rejects.toThrow(
      `Migration ledger mismatch for ${migrationModules.at(-1)?.name}`,
    )
  })
})

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
