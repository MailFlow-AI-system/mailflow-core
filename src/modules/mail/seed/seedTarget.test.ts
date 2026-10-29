import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceReader } from '#modules/identityWorkspace'
import { parseMailSeedArgs, parseMailSeedTarget, resolveMailSeedWorkspaceId } from './seedTarget.js'

const environment = { appEnv: 'development', workspaceOwnerId: 'owner-a' }
const workspace = { id: 'workspace-a', name: 'Alpha', slug: 'acme', role: 'owner' as const }
const authorityFor = () => ({ resolve: vi.fn().mockResolvedValue({ status: 'ok', workspace }) })
const readerFor = (...pages: Awaited<ReturnType<WorkspaceReader['list']>>[]) => {
  const list = vi.fn<WorkspaceReader['list']>()
  for (const page of pages) list.mockResolvedValueOnce(page)
  return { list }
}

describe('mail seed target', () => {
  it.each([{ workspaceId: 'workspace-a' }, { workspaceName: 'Alpha' }, { workspaceSlug: 'acme' }])(
    'accepts an explicit existing workspace selector: %o',
    (selector) => {
      expect(parseMailSeedTarget({ ...environment, ...selector })).toEqual({
        workspaceOwnerId: 'owner-a',
        ...selector,
      })
    },
  )

  it.each([
    { appEnv: undefined },
    { appEnv: 'production' },
    { nodeEnv: 'production' },
    { railwayEnvironmentId: 'published-environment' },
  ])('retains development guards: %o', (override) => {
    expect(() =>
      parseMailSeedTarget({ ...environment, workspaceSlug: 'acme', ...override }),
    ).toThrow('development')
  })

  it.each([
    {},
    { workspaceId: 'workspace-a', workspaceName: 'Alpha' },
    { workspaceSlug: 'acme', workspaceName: 'Alpha' },
    { workspaceId: 'workspace-a', workspaceSlug: 'acme' },
    { workspaceId: '' },
    { workspaceName: '' },
    { workspaceSlug: '' },
    { workspaceId: ' ' },
    { workspaceName: ' ' },
    { workspaceSlug: ' ' },
    { workspaceId: ' workspace-a' },
    { workspaceName: 'Alpha ' },
    { workspaceSlug: 'a--b' },
    { workspaceSlug: 'Acme' },
    { workspaceSlug: '-acme' },
    { workspaceSlug: 'acme-' },
    { workspaceSlug: 'acme.test' },
    { workspaceSlug: 'a'.repeat(64) },
  ])('rejects missing, ambiguous, or malformed selectors: %o', (selector) => {
    expect(() => parseMailSeedTarget({ ...environment, ...selector })).toThrow('workspace')
  })

  it.each([undefined, '', ' ', ' owner-a', 'owner-a '])(
    'requires an owner identity: %s',
    (workspaceOwnerId) => {
      expect(() =>
        parseMailSeedTarget({ ...environment, workspaceId: 'workspace-a', workspaceOwnerId }),
      ).toThrow('owner')
    },
  )

  it.each([
    [{ workspaceId: 'workspace-a' }, { workspaceId: 'workspace-a' }],
    [{ workspaceSlug: 'acme' }, { slug: 'acme' }],
  ] as const)('reauthorizes explicit selectors: %o', async (selector, selection) => {
    const authority = authorityFor()
    await expect(
      resolveMailSeedWorkspaceId(authority, { ...environment, ...selector }),
    ).resolves.toBe('workspace-a')
    expect(authority.resolve).toHaveBeenCalledWith('owner-a', selection)
  })

  it('finds an exact name across every membership page, then reauthorizes its ID', async () => {
    const authority = authorityFor()
    const reader = readerFor(
      { items: [{ ...workspace, id: 'other', name: 'alpha' }], nextCursor: 'other' },
      { items: [workspace], nextCursor: null },
    )
    await expect(
      resolveMailSeedWorkspaceId(authority, { ...environment, workspaceName: 'Alpha' }, reader),
    ).resolves.toBe('workspace-a')
    expect(reader.list.mock.calls).toEqual([
      ['owner-a', undefined],
      ['owner-a', 'other'],
    ])
    expect(authority.resolve).toHaveBeenCalledWith('owner-a', { workspaceId: 'workspace-a' })
  })

  it('rejects duplicate names across pages even when one membership is not owner', async () => {
    const authority = authorityFor()
    const reader = readerFor(
      { items: [workspace], nextCursor: 'workspace-a' },
      { items: [{ ...workspace, id: 'workspace-b', role: 'member' }], nextCursor: null },
    )
    await expect(
      resolveMailSeedWorkspaceId(authority, { ...environment, workspaceName: 'Alpha' }, reader),
    ).rejects.toThrow('ambiguous')
    expect(authority.resolve).not.toHaveBeenCalled()
  })

  it('does not fall back from an unknown or partial name', async () => {
    const authority = authorityFor()
    const reader = readerFor({ items: [{ ...workspace, name: 'Alpha Team' }], nextCursor: null })
    await expect(
      resolveMailSeedWorkspaceId(authority, { ...environment, workspaceName: 'Alpha' }, reader),
    ).rejects.toThrow('not found')
    expect(authority.resolve).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'required'])('rejects inaccessible selections: %s', async (status) => {
    const authority = { resolve: vi.fn().mockResolvedValue({ status }) }
    await expect(
      resolveMailSeedWorkspaceId(authority, { ...environment, workspaceId: 'workspace-a' }),
    ).rejects.toThrow('not found')
  })

  it.each(['admin', 'member'])('rejects nonowner membership: %s', async (role) => {
    const authority = {
      resolve: vi.fn().mockResolvedValue({ status: 'ok', workspace: { ...workspace, role } }),
    }
    await expect(
      resolveMailSeedWorkspaceId(authority, { ...environment, workspaceId: 'workspace-a' }),
    ).rejects.toThrow('owner')
  })

  it.each([
    [{ workspaceId: 'workspace-b' }, undefined],
    [{ workspaceSlug: 'other' }, undefined],
    [{ workspaceName: 'Alpha' }, { ...workspace, name: 'Renamed' }],
    [{ workspaceName: 'Alpha' }, { ...workspace, id: 'workspace-b' }],
  ])('rejects stale or mismatched authority results: %o', async (selector, resolved) => {
    const authority = authorityFor()
    if (resolved) authority.resolve.mockResolvedValueOnce({ status: 'ok', workspace: resolved })
    const reader = readerFor({ items: [workspace], nextCursor: null })
    await expect(
      resolveMailSeedWorkspaceId(authority, { ...environment, ...selector }, reader),
    ).rejects.toThrow('not found')
  })

  it('never resolves a default workspace when no selector was supplied', async () => {
    const authority = authorityFor()
    await expect(
      resolveMailSeedWorkspaceId(authority, { workspaceOwnerId: 'owner-a' }),
    ).rejects.toThrow('selector')
    expect(authority.resolve).not.toHaveBeenCalled()
  })

  it('requires a reader for a workspace name', async () => {
    const authority = authorityFor()
    await expect(
      resolveMailSeedWorkspaceId(authority, { ...environment, workspaceName: 'Alpha' }),
    ).rejects.toThrow('reader')
    expect(authority.resolve).not.toHaveBeenCalled()
  })

  it('propagates discovery and authority errors without fallback', async () => {
    const authority = authorityFor()
    const reader = { list: vi.fn().mockRejectedValue(new Error('discovery failed')) }
    await expect(
      resolveMailSeedWorkspaceId(authority, { ...environment, workspaceName: 'Alpha' }, reader),
    ).rejects.toThrow('discovery failed')
    expect(authority.resolve).not.toHaveBeenCalled()
    authority.resolve.mockRejectedValueOnce(new Error('authority failed'))
    await expect(
      resolveMailSeedWorkspaceId(authority, { ...environment, workspaceId: 'workspace-a' }),
    ).rejects.toThrow('authority failed')
  })
})

describe('mail seed CLI arguments', () => {
  it.each([
    ['--workspace-id=workspace-a', { workspaceId: 'workspace-a' }],
    ['--workspace-name=Alpha Team', { workspaceName: 'Alpha Team' }],
    ['--workspace-slug=acme', { workspaceSlug: 'acme' }],
  ] as const)('parses %s', (argument, selector) => {
    expect(parseMailSeedArgs([argument, '--workspace-owner-id', 'owner-a'], environment)).toEqual({
      ...selector,
      workspaceOwnerId: 'owner-a',
    })
  })

  it.each(['workspace-id', 'workspace-name', 'workspace-slug', 'workspace-owner-id'])(
    'rejects repeated --%s even with mixed syntax',
    (option) => {
      expect(() =>
        parseMailSeedArgs([`--${option}`, 'acme', `--${option}=acme`], environment),
      ).toThrow(`--${option} only once`)
    },
  )

  it.each([
    [],
    ['--workspace-id=workspace-a'],
    ['--workspace-owner-id=owner-a', '--workspace-id='],
    ['--workspace-owner-id=owner-a', '--workspace-name= '],
    ['--workspace-owner-id=owner-a', '--workspace-id=workspace-a', '--workspace-slug=acme'],
    ['--workspace-owner-id=owner-a', '--workspace-id=workspace-a', '--unknown=value'],
    ['--workspace-owner-id=owner-a', '--workspace-name'],
  ])('rejects invalid CLI arguments: %o', (...args) => {
    expect(() => parseMailSeedArgs(args, environment)).toThrow()
  })

  it('applies environment guards before connecting to infrastructure', () => {
    expect(() =>
      parseMailSeedArgs(['--workspace-id=workspace-a', '--workspace-owner-id=owner-a'], {
        appEnv: 'production',
      }),
    ).toThrow('development')
  })
})
