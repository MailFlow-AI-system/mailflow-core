import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMailWorkspaceAuthority, createWorkspaceReader } from '#modules/identityWorkspace'
import { createWorkspaceTestFixture } from '../../identityWorkspace/workspaces/fixtures.test-support.js'
import { parseMailSeedTarget, resolveMailSeedWorkspaceId } from './seedTarget.js'

describe('mail seed target with PostgreSQL isolation', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceTestFixture>>

  beforeAll(async () => {
    fixture = await createWorkspaceTestFixture()
  }, 30_000)

  afterAll(async () => {
    if (fixture) await fixture.close()
  })

  function resolve(
    workspaceOwnerId: string,
    selector: { workspaceId?: string; workspaceName?: string; workspaceSlug?: string },
  ) {
    return resolveMailSeedWorkspaceId(
      createMailWorkspaceAuthority(fixture.pool),
      parseMailSeedTarget({ appEnv: 'development', workspaceOwnerId, ...selector }),
      createWorkspaceReader(fixture.pool),
    )
  }

  it('resolves any existing owned workspace by ID, slug or exact name', async () => {
    await expect(resolve(fixture.userId, { workspaceId: fixture.acme })).resolves.toBe(fixture.acme)
    await expect(resolve(fixture.userId, { workspaceSlug: fixture.acmeSlug })).resolves.toBe(
      fixture.acme,
    )
    await expect(resolve(fixture.userId, { workspaceName: 'Acme Corp' })).resolves.toBe(
      fixture.acme,
    )
    await expect(resolve(fixture.otherId, { workspaceName: 'Globex' })).resolves.toBe(
      fixture.globex,
    )
  })

  it('rejects foreign, unknown and non-owner workspaces without preferred fallback', async () => {
    for (const selector of [
      { workspaceId: fixture.globex },
      { workspaceSlug: fixture.globexSlug },
      { workspaceName: 'Globex' },
      { workspaceId: 'missing-workspace' },
      { workspaceName: 'Missing Workspace' },
      { workspaceName: 'acme corp' },
      { workspaceId: fixture.northwind },
      { workspaceName: 'Northwind' },
    ]) {
      await expect(resolve(fixture.userId, selector)).rejects.toThrow()
    }
  })

  it('requires an ID or slug when accessible workspace names are duplicated', async () => {
    await fixture.admin.query(
      'update identity_workspace.organization set name = $1 where id = $2',
      ['Acme Corp', fixture.northwind],
    )
    try {
      await expect(resolve(fixture.userId, { workspaceName: 'Acme Corp' })).rejects.toThrow(
        /ambiguous|multiple|unique|more than one|duplicate/i,
      )
      await expect(resolve(fixture.userId, { workspaceId: fixture.acme })).resolves.toBe(
        fixture.acme,
      )
    } finally {
      await fixture.admin.query(
        'update identity_workspace.organization set name = $1 where id = $2',
        ['Northwind', fixture.northwind],
      )
    }
  })
})
