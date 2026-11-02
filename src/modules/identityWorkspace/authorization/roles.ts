import { type Capability, capabilities, isCapability } from './capabilities.js'

// Predefined roles live in code: immutable and versioned with the application.
export const predefinedRoles = [
  'owner',
  'admin',
  'member',
  'manager',
  'marketing_specialist',
  'analyst',
  'viewer',
] as const

export type PredefinedRole = (typeof predefinedRoles)[number]

// A custom role is stored per workspace (`workspace_role`) and referenced by `member.custom_role_id`.
export const customRoleKey = 'custom'
export const memberRoles = [...predefinedRoles, customRoleKey] as const
export type MemberRole = (typeof memberRoles)[number]

export const roleLabels: Record<PredefinedRole, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  member: 'Member',
  manager: 'Manager',
  marketing_specialist: 'Marketing Specialist',
  analyst: 'Analyst',
  viewer: 'Viewer',
}

const mailAccess: readonly Capability[] = ['mail.read', 'mail.compose']
const readOnly: readonly Capability[] = ['mail.read']

// Manager and Marketing Specialist match Member, and Analyst matches Viewer, until the modules that
// differentiate them exist. A single owner per workspace is enforced by the database.
const roleCapabilities: Record<PredefinedRole, readonly Capability[]> = {
  owner: capabilities,
  admin: capabilities.filter((capability) => capability !== 'admins.manage'),
  member: mailAccess,
  manager: mailAccess,
  marketing_specialist: mailAccess,
  analyst: readOnly,
  viewer: readOnly,
}

export function isPredefinedRole(value: string): value is PredefinedRole {
  return (predefinedRoles as readonly string[]).includes(value)
}

// Default deny: an unknown role, or a custom role without a stored definition, grants nothing.
export function resolveCapabilities(
  role: string,
  customCapabilities?: readonly string[] | null,
): Capability[] {
  if (role === customRoleKey) return (customCapabilities ?? []).filter(isCapability)
  return isPredefinedRole(role) ? [...roleCapabilities[role]] : []
}
