import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWorkspaceTestFixture } from './fixtures.test-support.js'
import { createMailWorkspaceAuthority } from './mailWorkspaceAuthority.js'
import { createWorkspaceSelection } from './workspaceSelection.js'

describe('mail workspace authority with PostgreSQL isolation', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceTestFixture>>
  beforeAll(async () => {
    fixture = await createWorkspaceTestFixture()
  }, 30_000)
  afterAll(async () => {
    if (fixture) await fixture.close()
  })

  it('requires a selection for multiple memberships, honors a live preference and rejects foreign selectors', async () => {
    const authority = createMailWorkspaceAuthority(fixture.pool)
    expect(await authority.resolve(fixture.userId)).toEqual({ status: 'required' })
    expect(await authority.resolve(fixture.userId, { workspaceId: fixture.globex })).toEqual({
      status: 'unavailable',
    })
    expect(
      await authority.resolve(fixture.userId, {
        workspaceId: fixture.acme,
        slug: fixture.northwindSlug,
      }),
    ).toEqual({ status: 'unavailable' })
    expect(await authority.resolve('no-membership')).toEqual({ status: 'required' })
    await createWorkspaceSelection(fixture.pool).select(fixture.userId, fixture.northwind)
    expect(await authority.resolve(fixture.userId)).toMatchObject({
      status: 'ok',
      workspace: { id: fixture.northwind },
    })
    await fixture.admin.query(
      'delete from identity_workspace.member where user_id=$1 and organization_id=$2',
      [fixture.userId, fixture.northwind],
    )
    expect(await authority.resolve(fixture.userId, { workspaceId: fixture.northwind })).toEqual({
      status: 'unavailable',
    })
    expect(await authority.resolve(fixture.userId)).toMatchObject({
      status: 'ok',
      workspace: { id: fixture.acme },
    })
    await fixture.admin.query(
      "insert into identity_workspace.member(id,organization_id,user_id,role,created_at) values('mail-stale-' || $1,$2,$1,'member',now())",
      [fixture.userId, fixture.globex],
    )
    expect(await authority.resolve(fixture.userId)).toEqual({ status: 'required' })
  })
})
