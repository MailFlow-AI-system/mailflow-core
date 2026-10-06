import { describe, expect, it } from 'vitest'

import { loadMigrationConfig } from './migrationConfig.js'

const directUrl = 'postgresql://migrator:password@localhost:5432/mailflow'

describe('loadMigrationConfig', () => {
  it('loads only DIRECT_URL without application configuration', () => {
    expect(loadMigrationConfig({ DIRECT_URL: directUrl })).toEqual({ directUrl })
  })

  it('uses DIRECT_URL even when DATABASE_URL points elsewhere', () => {
    expect(
      loadMigrationConfig({ DIRECT_URL: directUrl, DATABASE_URL: 'postgresql://wrong/other' }),
    ).toEqual({ directUrl })
  })

  it.each([undefined, '', 'not-a-url', 'https://example.com/db', 'postgresql:///db'])(
    'rejects invalid DIRECT_URL %s without falling back to DATABASE_URL',
    (value) => {
      const environment: NodeJS.ProcessEnv = { DATABASE_URL: directUrl }
      if (value !== undefined) environment.DIRECT_URL = value
      expect(() => loadMigrationConfig(environment)).toThrow('DIRECT_URL')
    },
  )

  it('rejects a pooled Neon endpoint', () => {
    expect(() =>
      loadMigrationConfig({ DIRECT_URL: 'postgresql://user:password@ep-test-pooler.neon.tech/db' }),
    ).toThrow('DIRECT_URL')
  })

  it('does not include credentials in configuration errors', () => {
    expect(() =>
      loadMigrationConfig({ DIRECT_URL: 'https://user:secret-password@localhost/db' }),
    ).toThrow(/^DIRECT_URL must be a valid direct PostgreSQL connection URL$/)
  })
})
