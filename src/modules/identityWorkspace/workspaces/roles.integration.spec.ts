import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { capabilities } from '../authorization/capabilities.js'
import { predefinedRoles } from '../authorization/roles.js'
import { createWorkspaceTestFixture } from './fixtures.test-support.js'
import { inIdentityTransaction } from './identityTransaction.js'
import { createMailWorkspaceAuthority } from './mailWorkspaceAuthority.js'
import { createWorkspaceReader } from './workspaceReader.js'

describe('role model and capability resolution with PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceTestFixture>>
  beforeAll(async () => {
    fixture = await createWorkspaceTestFixture()
  }, 30_000)
  afterAll(async () => {
    if (fixture) await fixture.close()
  })
  // The fixture user is a plain member of Northwind and the owner of Acme.
  afterEach(async () => {
    await setRole('member')
    await fixture.admin.query(
      'delete from identity_workspace.workspace_role where organization_id = any($1::text[])',
      [[fixture.acme, fixture.northwind, fixture.globex]],
    )
  })

  function setRole(role: string, customRoleId: string | null = null, organizationId?: string) {
    return fixture.admin.query(
      'update identity_workspace.member set role = $1, custom_role_id = $2 where user_id = $3 and organization_id = $4',
      [role, customRoleId, fixture.userId, organizationId ?? fixture.northwind],
    )
  }
  async function createRole(organizationId: string, name: string, stored: string[]) {
    const id = randomUUID()
    await fixture.admin.query(
      'insert into identity_workspace.workspace_role(id, organization_id, name, capabilities, created_at) values($1, $2, $3, $4, now())',
      [id, organizationId, name, stored],
    )
    return id
  }
  const northwindAccess = async () => {
    const result = await createMailWorkspaceAuthority(fixture.pool).resolve(fixture.userId, {
      workspaceId: fixture.northwind,
    })
    if (result.status !== 'ok') throw new Error(`Expected access, got ${result.status}`)
    return result.workspace
  }

  describe('member.role constraints', () => {
    it.each(predefinedRoles.filter((role) => role !== 'owner'))(
      'accepts the %s role',
      async (role) => {
        await expect(setRole(role)).resolves.toBeDefined()
      },
    )

    it.each(['superuser', 'Owner', 'administrator', ''])(
      'rejects the unknown role %j',
      async (role) => {
        await expect(setRole(role)).rejects.toMatchObject({ code: '23514' })
      },
    )

    it('keeps exactly one owner per workspace', async () => {
      await expect(setRole('owner')).rejects.toMatchObject({ code: '23505' })
      await expect(
        fixture.admin.query(
          "update identity_workspace.member set role = 'viewer' where user_id = $1 and organization_id = $2",
          [fixture.otherId, fixture.northwind],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    })

    it('pairs the custom role key with a stored role', async () => {
      const stored = await createRole(fixture.northwind, 'Reviewer', ['mail.read'])
      await expect(setRole('custom')).rejects.toMatchObject({ code: '23514' })
      await expect(setRole('viewer', stored)).rejects.toMatchObject({ code: '23514' })
      await expect(setRole('custom', stored)).resolves.toBeDefined()
    })
  })

  describe('custom roles stay inside their workspace', () => {
    it('refuses a role that belongs to another workspace', async () => {
      const foreign = await createRole(fixture.globex, 'Foreign', ['mail.read'])
      await expect(setRole('custom', foreign)).rejects.toMatchObject({ code: '23503' })
    })

    it('refuses to delete a role that a member still uses', async () => {
      const stored = await createRole(fixture.northwind, 'In use', ['mail.read'])
      await setRole('custom', stored)
      await expect(
        fixture.admin.query('delete from identity_workspace.workspace_role where id = $1', [
          stored,
        ]),
      ).rejects.toMatchObject({ code: '23503' })
    })

    it('keeps role names unique per workspace, ignoring case', async () => {
      await createRole(fixture.northwind, 'Reviewer', ['mail.read'])
      await expect(createRole(fixture.northwind, 'reviewer', [])).rejects.toMatchObject({
        code: '23505',
      })
      await expect(createRole(fixture.globex, 'Reviewer', [])).resolves.toBeDefined()
    })
  })

  describe('row level security on workspace_role', () => {
    it('shows a member only the roles of workspaces they belong to', async () => {
      const visible = await createRole(fixture.northwind, 'Visible', ['mail.read'])
      await createRole(fixture.globex, 'Hidden', ['mail.read'])

      const rows = await inIdentityTransaction(fixture.pool, fixture.userId, (client) =>
        client.query('select id from identity_workspace.workspace_role'),
      )
      expect(rows.rows).toEqual([{ id: visible }])
    })

    it('shows nothing without an identity context, even on a reused connection', async () => {
      await createRole(fixture.northwind, 'Visible', ['mail.read'])
      await inIdentityTransaction(fixture.pool, fixture.userId, (client) =>
        client.query('select 1'),
      )

      const result = await fixture.pool.query('select id from identity_workspace.workspace_role')
      expect(result.rows).toEqual([])
    })

    it('lets the runtime role read but never write roles', async () => {
      await expect(
        inIdentityTransaction(fixture.pool, fixture.userId, (client) =>
          client.query(
            "insert into identity_workspace.workspace_role(id, organization_id, name, capabilities, created_at) values('x', $1, 'Mine', '{}', now())",
            [fixture.northwind],
          ),
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining('row-level security') })
    })
  })

  describe('effective capabilities', () => {
    it('grants the owner every capability', async () => {
      const result = await createMailWorkspaceAuthority(fixture.pool).resolve(fixture.userId, {
        workspaceId: fixture.acme,
      })
      expect(result).toMatchObject({ status: 'ok', workspace: { role: 'owner' } })
      if (result.status === 'ok')
        expect([...result.workspace.capabilities].sort()).toEqual([...capabilities].sort())
    })

    it.each([
      ['member', ['mail.compose', 'mail.read']],
      ['manager', ['mail.compose', 'mail.read']],
      ['marketing_specialist', ['mail.compose', 'mail.read']],
      ['analyst', ['mail.read']],
      ['viewer', ['mail.read']],
    ])('resolves the %s role', async (role, expected) => {
      await setRole(role)
      const access = await northwindAccess()
      expect(access.role).toBe(role)
      expect([...access.capabilities].sort()).toEqual(expected)
    })

    it('resolves a custom role from its stored capabilities and drops unknown names', async () => {
      const stored = await createRole(fixture.northwind, 'Reviewer', [
        'mail.read',
        'not.a.capability',
        'workspace.manage',
      ])
      await setRole('custom', stored)

      const access = await northwindAccess()
      expect(access.role).toBe('custom')
      expect([...access.capabilities].sort()).toEqual(['mail.read', 'workspace.manage'])
    })

    it('denies a custom role with no stored capabilities', async () => {
      await setRole('custom', await createRole(fixture.northwind, 'Empty', []))

      expect((await northwindAccess()).capabilities).toEqual([])
    })

    it('returns the same capabilities from the workspace reader', async () => {
      await setRole('viewer')
      const context = await createWorkspaceReader(fixture.pool).context(
        fixture.userId,
        fixture.northwindSlug,
      )
      expect(context).toMatchObject({ role: 'viewer', capabilities: ['mail.read'] })
      expect(
        await createWorkspaceReader(fixture.pool).context(fixture.userId, fixture.globexSlug),
      ).toBeNull()
    })

    it('leaves the list of workspaces on the role only', async () => {
      const page = await createWorkspaceReader(fixture.pool).list(fixture.userId)
      for (const item of page.items) expect(item).not.toHaveProperty('capabilities')
    })
  })
})
