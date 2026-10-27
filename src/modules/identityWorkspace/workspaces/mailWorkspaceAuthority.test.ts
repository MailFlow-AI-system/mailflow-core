import { describe, expect, it, vi } from 'vitest'
import { createMailWorkspaceAuthority } from './mailWorkspaceAuthority.js'
import type { WorkspacePool } from './types.js'

const first = { id: 'workspace-a', name: 'Alpha', slug: 'alpha', role: 'owner', preferred: false }
const second = { id: 'workspace-b', name: 'Beta', slug: 'beta', role: 'member', preferred: false }
function setup(rows: unknown[]) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('from identity_workspace.organization') ? rows : [],
    command: sql,
  }))
  const pool = { connect: vi.fn(async () => ({ query, release: vi.fn() })) }
  return { authority: createMailWorkspaceAuthority(pool as unknown as WorkspacePool), query }
}
describe('mail workspace authority', () => {
  it('requires an explicit choice when multiple memberships have no valid preference', async () => {
    const { authority } = setup([first, second])
    await expect(authority.resolve('user-a')).resolves.toEqual({ status: 'required' })
  })
  it('selects a validated preference or sole membership', async () => {
    await expect(
      setup([{ ...second, preferred: true }, first]).authority.resolve('user-a'),
    ).resolves.toMatchObject({ status: 'ok', workspace: { id: second.id } })
    await expect(setup([first]).authority.resolve('user-a')).resolves.toMatchObject({
      status: 'ok',
      workspace: { id: first.id },
    })
    await expect(setup([]).authority.resolve('user-a')).resolves.toEqual({ status: 'required' })
  })
  it('rejects foreign or stale explicit selectors without fallback', async () => {
    const { authority, query } = setup([])
    await expect(authority.resolve('user-a', { workspaceId: 'foreign' })).resolves.toEqual({
      status: 'unavailable',
    })
    expect(query).toHaveBeenCalledWith(expect.stringContaining('m.user_id = $1'), [
      'user-a',
      'foreign',
      null,
    ])
  })
  it('constrains a trusted tenant slug together with the selected ID', async () => {
    const { authority, query } = setup([])
    await expect(
      authority.resolve('user-a', { workspaceId: 'workspace-a', slug: 'beta' }),
    ).resolves.toEqual({ status: 'unavailable' })
    expect(query).toHaveBeenCalledWith(expect.stringContaining('o.slug = $3'), [
      'user-a',
      'workspace-a',
      'beta',
    ])
  })
})
