import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWorkspaceTestFixture } from './fixtures.test-support.js'
import { createWorkspaceEntryReader } from './workspaceEntryReader.js'
import { createWorkspaceSelection } from './workspaceSelection.js'

describe('workspace entry PostgreSQL authority', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceTestFixture>>
  beforeAll(async () => {
    fixture = await createWorkspaceTestFixture()
  }, 30000)
  afterAll(async () => {
    if (fixture) await fixture.close()
  })

  it('resumes a persisted preference only through a live membership', async () => {
    await createWorkspaceSelection(fixture.pool).select(fixture.userId, fixture.northwind)
    expect(await createWorkspaceEntryReader(fixture.pool).resolve(fixture.userId)).toEqual({
      source: 'preference',
      workspace: {
        id: fixture.northwind,
        name: 'Northwind',
        slug: fixture.northwindSlug,
        role: 'member',
      },
    })
  })

  it('falls back by stable ID after revocation without rewriting the preference', async () => {
    await fixture.admin.query(
      'delete from identity_workspace.member where user_id=$1 and organization_id=$2',
      [fixture.userId, fixture.northwind],
    )
    expect(await createWorkspaceEntryReader(fixture.pool).resolve(fixture.userId)).toMatchObject({
      source: 'fallback',
      workspace: { id: fixture.acme },
    })
    expect(
      (
        await fixture.admin.query(
          'select workspace_id from identity_workspace.workspace_preference where user_id=$1',
          [fixture.userId],
        )
      ).rows,
    ).toEqual([{ workspace_id: fixture.northwind }])
  })
  it('returns no workspace for an identity with no membership, never somebody else’s preference', async () => {
    expect(await createWorkspaceEntryReader(fixture.pool).resolve('unrelated-identity')).toEqual({
      source: 'none',
      workspace: null,
    })
    expect(
      (await fixture.pool.query('select * from identity_workspace.workspace_preference')).rows,
    ).toEqual([])
  })
  it('reads each identity’s own preference with a reused restricted pool', async () => {
    await createWorkspaceSelection(fixture.pool).select(fixture.otherId, fixture.globex)
    const entry = createWorkspaceEntryReader(fixture.pool)
    const [actor, other] = await Promise.all([
      entry.resolve(fixture.userId),
      entry.resolve(fixture.otherId),
    ])
    expect(actor).toMatchObject({ source: 'fallback', workspace: { id: fixture.acme } })
    expect(other).toMatchObject({ source: 'preference', workspace: { id: fixture.globex } })
    expect(
      (await fixture.pool.query('select * from identity_workspace.workspace_preference')).rows,
    ).toEqual([])
  })
  it('chooses the same stable-ID fallback repeatedly when no preference exists', async () => {
    await fixture.admin.query(
      "insert into identity_workspace.member(id,organization_id,user_id,role,created_at) values('entry-restore-' || $1,$2,$1,'member',now()) on conflict(organization_id,user_id) do nothing",
      [fixture.userId, fixture.northwind],
    )
    await fixture.admin.query(
      'delete from identity_workspace.workspace_preference where user_id=$1',
      [fixture.userId],
    )
    const entry = createWorkspaceEntryReader(fixture.pool)
    const expected = [fixture.acme, fixture.northwind].sort()[0]
    for (let iteration = 0; iteration < 3; iteration += 1)
      expect(await entry.resolve(fixture.userId)).toMatchObject({
        source: 'fallback',
        workspace: { id: expected },
      })
    expect(
      (
        await fixture.admin.query(
          'select * from identity_workspace.workspace_preference where user_id=$1',
          [fixture.userId],
        )
      ).rows,
    ).toEqual([])
  })
})
