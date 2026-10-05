import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWorkspaceTestFixture } from './fixtures.test-support.js'
import { inIdentityTransaction } from './identityTransaction.js'
import { assertWorkspaceSelectionDatabaseRole } from './selectionDatabaseRole.js'
import { createWorkspaceSelection } from './workspaceSelection.js'

describe('workspace selection PostgreSQL authority', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceTestFixture>>
  beforeAll(async () => {
    fixture = await createWorkspaceTestFixture()
  }, 30000)
  afterAll(async () => {
    if (fixture) await fixture.close()
  })

  it('persists an authorized selection before returning its live summary', async () => {
    await assertWorkspaceSelectionDatabaseRole(fixture.pool)
    await expect(assertWorkspaceSelectionDatabaseRole(fixture.admin)).rejects.toThrow(
      'isolated preference',
    )
    const selection = createWorkspaceSelection(fixture.pool)
    expect(await selection.select(fixture.userId, fixture.northwind)).toMatchObject({
      id: fixture.northwind,
      name: 'Northwind',
      role: 'member',
    })
    const result = await fixture.admin.query(
      'select workspace_id from identity_workspace.workspace_preference where user_id=$1',
      [fixture.userId],
    )
    expect(result.rows).toEqual([{ workspace_id: fixture.northwind }])
  })

  it('does not replace the preference for unknown or unrelated workspaces', async () => {
    const selection = createWorkspaceSelection(fixture.pool)
    await selection.select(fixture.userId, fixture.acme)
    expect(await selection.select(fixture.userId, fixture.globex)).toBeNull()
    expect(await selection.select(fixture.userId, 'absent')).toBeNull()
    const result = await fixture.admin.query(
      'select workspace_id from identity_workspace.workspace_preference where user_id=$1',
      [fixture.userId],
    )
    expect(result.rows).toEqual([{ workspace_id: fixture.acme }])
  })

  it('hides preferences without the identity and denies direct preference writes', async () => {
    expect(
      (await fixture.pool.query('select * from identity_workspace.workspace_preference')).rows,
    ).toEqual([])
    expect(
      await inIdentityTransaction(
        fixture.pool,
        'another-user',
        async (client) =>
          (await client.query('select * from identity_workspace.workspace_preference')).rows,
      ),
    ).toEqual([])
    await expect(
      inIdentityTransaction(fixture.pool, fixture.userId, (client) =>
        client.query(
          'insert into identity_workspace.workspace_preference(user_id,workspace_id) values($1,$2)',
          [fixture.userId, fixture.globex],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    expect(
      await inIdentityTransaction(
        fixture.pool,
        fixture.userId,
        async (client) =>
          (
            await client.query(
              'update identity_workspace.workspace_preference set workspace_id=$1',
              [fixture.globex],
            )
          ).rowCount,
      ),
    ).toBe(0)
    expect(
      await createWorkspaceSelection(fixture.pool).select('another-user', fixture.acme),
    ).toBeNull()
  })

  it('revalidates a revoked membership without modifying the old preference', async () => {
    await fixture.admin.query(
      'delete from identity_workspace.member where user_id=$1 and organization_id=$2',
      [fixture.userId, fixture.northwind],
    )
    expect(
      await createWorkspaceSelection(fixture.pool).select(fixture.userId, fixture.northwind),
    ).toBeNull()
    const result = await fixture.admin.query(
      'select workspace_id from identity_workspace.workspace_preference where user_id=$1',
      [fixture.userId],
    )
    expect(result.rows).toEqual([{ workspace_id: fixture.acme }])
  })

  it('rolls back a preference write when the transaction fails before commit', async () => {
    await fixture.admin.query(
      "insert into identity_workspace.member(id,organization_id,user_id,role,created_at) values('rollback-member-' || $1,$2,$1,'member',now()) on conflict(organization_id,user_id) do nothing",
      [fixture.userId, fixture.northwind],
    )
    await createWorkspaceSelection(fixture.pool).select(fixture.userId, fixture.acme)
    await expect(
      inIdentityTransaction(fixture.pool, fixture.userId, async (client) => {
        await client.query('select * from identity_workspace.select_workspace_preference($1)', [
          fixture.northwind,
        ])
        await client.query('select 1/0')
      }),
    ).rejects.toMatchObject({ code: '22012' })
    const result = await fixture.admin.query(
      'select workspace_id from identity_workspace.workspace_preference where user_id=$1',
      [fixture.userId],
    )
    expect(result.rows).toEqual([{ workspace_id: fixture.acme }])
    expect(
      (await fixture.pool.query('select * from identity_workspace.workspace_preference')).rows,
    ).toEqual([])
  })

  it('holds membership authorization until the preference transaction commits', async () => {
    await fixture.admin.query(
      "insert into identity_workspace.member(id,organization_id,user_id,role,created_at) values('selection-lock-' || $1,$2,$1,'member',now()) on conflict(organization_id,user_id) do nothing",
      [fixture.userId, fixture.northwind],
    )
    const selecting = await fixture.pool.connect()
    const revoking = await fixture.admin.connect()
    try {
      await selecting.query('BEGIN')
      await selecting.query("select set_config('mailflow.user_id',$1,true)", [fixture.userId])
      await selecting.query('select * from identity_workspace.select_workspace_preference($1)', [
        fixture.northwind,
      ])
      const {
        rows: [{ pid }],
      } = await revoking.query('select pg_backend_pid() as pid')
      const deletion = revoking.query(
        'delete from identity_workspace.member where user_id=$1 and organization_id=$2',
        [fixture.userId, fixture.northwind],
      )
      await expect
        .poll(
          async () =>
            (
              await fixture.admin.query(
                'select wait_event_type from pg_stat_activity where pid=$1',
                [pid],
              )
            ).rows[0]?.wait_event_type,
        )
        .toBe('Lock')
      await selecting.query('COMMIT')
      await deletion
      expect(
        await createWorkspaceSelection(fixture.pool).select(fixture.userId, fixture.northwind),
      ).toBeNull()
    } finally {
      await selecting.query('ROLLBACK')
      selecting.release()
      revoking.release()
    }
  })
})
