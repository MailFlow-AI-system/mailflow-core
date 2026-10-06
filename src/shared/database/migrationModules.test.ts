import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readMigrationFiles } from 'drizzle-orm/migrator'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { migrationModules, migrationTable } from './migrationModules.js'

async function validateMigrationFolders(root: string, modules: readonly { folder: string }[]) {
  const folders = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(
    modules.map((module) => module.folder).sort(),
    folders,
    'Migration folders must match the registered modules',
  )
  for (const module of modules) {
    readMigrationFiles({ migrationsFolder: join(root, module.folder) })
  }
}

describe('migration module registry', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true })))
  })

  it('registers every migration folder with a readable journal and its SQL files', async () => {
    const root = fileURLToPath(new URL('../../../database/migrations/', import.meta.url))
    await validateMigrationFolders(root, migrationModules)
    expect(new Set(migrationModules.map((module) => module.name)).size).toBe(
      migrationModules.length,
    )
    expect(new Set(migrationModules.map((module) => module.schema)).size).toBe(
      migrationModules.length,
    )
  })

  it('detects a migration folder omitted from the registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mailflow-migration-registry-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'newModule'))
    await expect(validateMigrationFolders(root, [])).rejects.toThrow(
      'Migration folders must match the registered modules',
    )
  })

  it('detects a registered module whose journal is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mailflow-migration-registry-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'newModule'))
    await expect(validateMigrationFolders(root, [{ folder: 'newModule' }])).rejects.toThrow(
      "Can't find meta/_journal.json file",
    )
  })

  it('detects a journal referencing a missing SQL migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mailflow-migration-registry-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'newModule', 'meta'), { recursive: true })
    await writeFile(
      join(root, 'newModule', 'meta', '_journal.json'),
      JSON.stringify({ entries: [{ tag: '0000_missing', when: 1, breakpoints: true }] }),
    )
    await expect(validateMigrationFolders(root, [{ folder: 'newModule' }])).rejects.toThrow(
      '0000_missing.sql',
    )
  })

  it('uses the same migration metadata for Drizzle generation and execution', async () => {
    vi.stubEnv('DIRECT_URL', 'postgresql://generator:fixture@localhost:5432/mailflow')
    const configs = await Promise.all(
      migrationModules.map(async (module) => {
        const configPath = `../../../database/configs/${module.folder}.js`
        return (await import(configPath)).default
      }),
    )
    expect(configs.map((config) => config.out)).toEqual(
      migrationModules.map((module) => `./database/migrations/${module.folder}`),
    )
    expect(configs.map((config) => config.migrations)).toEqual(
      migrationModules.map((module) => ({ schema: module.schema, table: migrationTable })),
    )
  })
})
