import { describe, expect, it } from 'vitest'
import { capabilities } from './capabilities.js'
import {
  customRoleKey,
  memberRoles,
  predefinedRoles,
  resolveCapabilities,
  roleLabels,
} from './roles.js'

describe('predefined roles', () => {
  it('gives the owner every capability', () => {
    expect(resolveCapabilities('owner').sort()).toEqual([...capabilities].sort())
  })

  it('gives the administrator everything except managing other administrators', () => {
    const admin = resolveCapabilities('admin')
    expect(admin).not.toContain('admins.manage')
    expect(admin.sort()).toEqual(capabilities.filter((name) => name !== 'admins.manage').sort())
  })

  it('lets members, managers and marketing specialists read and compose mail only', () => {
    for (const role of ['member', 'manager', 'marketing_specialist']) {
      expect(resolveCapabilities(role).sort()).toEqual(['mail.compose', 'mail.read'])
    }
  })

  it('lets analysts and viewers read mail only', () => {
    for (const role of ['analyst', 'viewer'])
      expect(resolveCapabilities(role)).toEqual(['mail.read'])
  })

  it('never grants administration to a non-administrative role', () => {
    for (const role of ['member', 'manager', 'marketing_specialist', 'analyst', 'viewer']) {
      const granted = resolveCapabilities(role)
      expect(granted).not.toContain('members.manage')
      expect(granted).not.toContain('admins.manage')
      expect(granted).not.toContain('workspace.manage')
    }
  })

  it('names every predefined role and keeps the product role names', () => {
    expect(Object.keys(roleLabels).sort()).toEqual([...predefinedRoles].sort())
    expect(roleLabels).toMatchObject({
      owner: 'Owner',
      admin: 'Administrator',
      manager: 'Manager',
      marketing_specialist: 'Marketing Specialist',
      analyst: 'Analyst',
      viewer: 'Viewer',
    })
  })

  it('accepts the custom role key next to the predefined roles for stored members', () => {
    expect(memberRoles).toEqual([...predefinedRoles, customRoleKey])
  })
})

describe('resolveCapabilities', () => {
  it('denies by default for unknown roles', () => {
    expect(resolveCapabilities('')).toEqual([])
    expect(resolveCapabilities('superuser')).toEqual([])
    expect(resolveCapabilities('Owner')).toEqual([])
  })

  it('grants a custom role only the known capabilities it stores', () => {
    expect(
      resolveCapabilities('custom', ['mail.read', 'unknown.thing', 'workspace.manage']),
    ).toEqual(['mail.read', 'workspace.manage'])
  })

  it('denies a custom role without a stored definition', () => {
    expect(resolveCapabilities('custom')).toEqual([])
    expect(resolveCapabilities('custom', null)).toEqual([])
  })

  it('ignores custom capabilities for predefined roles', () => {
    expect(resolveCapabilities('viewer', ['members.manage'])).toEqual(['mail.read'])
  })

  it('returns a fresh array so callers cannot change a role', () => {
    const first = resolveCapabilities('member')
    first.push('members.manage')
    expect(resolveCapabilities('member')).toEqual(['mail.read', 'mail.compose'])
  })
})
