import type { MigrationMeta } from 'drizzle-orm/migrator'
import type { Client } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { verifyMigrationLedgers } from './migrationLedgers.js'
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
