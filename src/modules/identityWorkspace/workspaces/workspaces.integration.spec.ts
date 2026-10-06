import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertWorkspaceDatabaseRole } from './databaseRole.js'
import { createDiscoveryBudget } from './discoveryBudget.js'
import { createWorkspaceTestFixture } from './fixtures.test-support.js'
import { inIdentityTransaction } from './identityTransaction.js'
import { createWorkspaceReader } from './workspaceReader.js'

describe('workspace PostgreSQL authority', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceTestFixture>>
  beforeAll(async () => {
    fixture = await createWorkspaceTestFixture()
  }, 30000)
  afterAll(async () => {
    if (fixture) await fixture.close()
  })
  it('verifies role and reads only authenticated memberships', async () => {
    await assertWorkspaceDatabaseRole(fixture.pool)
    await expect(assertWorkspaceDatabaseRole(fixture.admin)).rejects.toThrow('non-owner')
    const reader = createWorkspaceReader(fixture.pool)
    const page = await reader.list(fixture.userId)
    expect(page.items.map((w) => w.name).sort()).toEqual(['Acme Corp', 'Northwind'])
    expect(page.nextCursor).toBeNull()
    expect(await reader.context(fixture.userId, fixture.acmeSlug)).toMatchObject({
      id: fixture.acme,
      role: 'owner',
    })
    expect(await reader.context(fixture.userId, fixture.globexSlug)).toBeNull()
  })
  it('denies direct SQL without identity and unapproved mutations', async () => {
    expect(
      (await fixture.pool.query('select * from identity_workspace.organization')).rows,
    ).toEqual([])
    expect((await fixture.pool.query('select * from identity_workspace.member')).rows).toEqual([])
    await expect(
      inIdentityTransaction(fixture.pool, fixture.userId, (client) =>
        client.query(
          `insert into identity_workspace.organization (id, name, slug, created_at) values ($1,'forged','forged',now())`,
          [randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    const changed = await inIdentityTransaction(fixture.pool, fixture.userId, (client) =>
      client.query('update identity_workspace.member set role = $1 where organization_id = $2', [
        'owner',
        fixture.northwind,
      ]),
    )
    expect(changed.rowCount).toBe(0)
  })
  it('removes context after rollback and concurrent pool reuse', async () => {
    await expect(
      inIdentityTransaction(fixture.pool, fixture.userId, async () => {
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    const reader = createWorkspaceReader(fixture.pool)
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        reader.list(i % 2 ? 'unknown-identity' : fixture.userId),
      ),
    )
    results.forEach((page, i) => {
      expect(page.items).toHaveLength(i % 2 ? 0 : 2)
    })
    expect(
      (await fixture.pool.query('select * from identity_workspace.organization')).rows,
    ).toEqual([])
  })
  it('rejects an organization without an owner at commit', async () => {
    const client = await fixture.admin.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `insert into identity_workspace.organization(id,name,slug,created_at) values ($1,'Orphan',$2,now())`,
        [randomUUID(), `orphan-${randomUUID()}`],
      )
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
  it('keeps explicit contexts isolated across two live identities sharing the restricted pool', async () => {
    const reader = createWorkspaceReader(fixture.pool)
    const results = await Promise.all(
      Array.from({ length: 24 }, async (_, index) => {
        const userId = index % 2 ? fixture.otherId : fixture.userId
        const [acme, northwind, globex] = await Promise.all([
          reader.context(userId, fixture.acmeSlug),
          reader.context(userId, fixture.northwindSlug),
          reader.context(userId, fixture.globexSlug),
        ])
        return { acme, northwind, globex }
      }),
    )
    results.forEach((result, index) => {
      if (index % 2) {
        expect(result.acme).toBeNull()
        expect(result.northwind).toMatchObject({ id: fixture.northwind, role: 'owner' })
        expect(result.globex).toMatchObject({ id: fixture.globex, role: 'owner' })
      } else {
        expect(result.acme).toMatchObject({ id: fixture.acme, role: 'owner' })
        expect(result.northwind).toMatchObject({ id: fixture.northwind, role: 'member' })
        expect(result.globex).toBeNull()
      }
    })
    expect(
      (await fixture.pool.query('select * from identity_workspace.organization')).rows,
    ).toEqual([])
  })
  it('enforces unique slugs, unique memberships and at most one owner', async () => {
    await expect(
      fixture.admin.query('update identity_workspace.organization set slug = $1 where id = $2', [
        fixture.acmeSlug,
        fixture.northwind,
      ]),
    ).rejects.toMatchObject({ code: '23505' })
    await expect(
      fixture.admin.query(
        `insert into identity_workspace.member(id, organization_id, user_id, role, created_at)
       values ($1, $2, $3, 'member', now())`,
        [randomUUID(), fixture.acme, fixture.userId],
      ),
    ).rejects.toMatchObject({ code: '23505' })
    await expect(
      fixture.admin.query(
        "update identity_workspace.member set role = 'owner' where organization_id = $1 and user_id = $2",
        [fixture.northwind, fixture.userId],
      ),
    ).rejects.toMatchObject({ code: '23505' })
    await expect(
      fixture.admin.query(
        "delete from identity_workspace.member where organization_id = $1 and role = 'owner'",
        [fixture.acme],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    expect(
      await createWorkspaceReader(fixture.pool).context(fixture.userId, fixture.acmeSlug),
    ).toMatchObject({ role: 'owner' })
  })
  it('uses an atomic cross-instance discovery budget scoped to identity', async () => {
    const consume = createDiscoveryBudget(fixture.pool)
    const outcomes = await Promise.all(Array.from({ length: 121 }, () => consume(fixture.userId)))
    expect(outcomes.filter((x) => x === 0)).toHaveLength(120)
    expect(outcomes.filter((x) => x > 0)).toHaveLength(1)
  })
  it('keeps another identity available during a bounded burst across independent budget instances', async () => {
    const attackerId = `budget-burst-${randomUUID()}`
    const observerId = `budget-observer-${randomUUID()}`
    const firstInstance = createDiscoveryBudget(fixture.pool)
    const secondInstance = createDiscoveryBudget(fixture.pool)
    try {
      const [burst, observations] = await Promise.all([
        Promise.all(
          Array.from({ length: 150 }, (_, index) =>
            (index % 2 ? firstInstance : secondInstance)(attackerId),
          ),
        ),
        Promise.all(Array.from({ length: 20 }, () => secondInstance(observerId))),
      ])
      expect(burst.filter((retryAfter) => retryAfter === 0)).toHaveLength(120)
      expect(burst.filter((retryAfter) => retryAfter > 0)).toHaveLength(30)
      expect(observations).toEqual(Array(20).fill(0))
    } finally {
      await fixture.admin.query('delete from identity_workspace.rate_limit where key = any($1)', [
        [`workspace-discovery:${attackerId}`, `workspace-discovery:${observerId}`],
      ])
    }
  })
})
