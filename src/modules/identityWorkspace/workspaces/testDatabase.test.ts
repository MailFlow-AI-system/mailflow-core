import { describe, expect, it } from 'vitest'
import { workspaceTestDatabaseUrl } from './testDatabase.test-support.js'

describe('workspace test database URL', () => {
  it('defaults to the compose and CI PostgreSQL service', () => {
    expect(workspaceTestDatabaseUrl({})).toBe(
      'postgresql://mailflow:mailflow@localhost:5432/mailflow',
    )
  })

  it('accepts another local database override', () => {
    expect(
      workspaceTestDatabaseUrl({
        MAILFLOW_WORKSPACE_TEST_DATABASE_URL: 'postgresql://admin:secret@127.0.0.1:5433/scratch',
      }),
    ).toBe('postgresql://admin:secret@127.0.0.1:5433/scratch')
  })

  it('rejects remote databases', () => {
    expect(() =>
      workspaceTestDatabaseUrl({
        MAILFLOW_WORKSPACE_TEST_DATABASE_URL: 'postgresql://app:secret@ep-example.neon.tech/neondb',
      }),
    ).toThrow('Workspace tests require a disposable local PostgreSQL database')
  })
})
