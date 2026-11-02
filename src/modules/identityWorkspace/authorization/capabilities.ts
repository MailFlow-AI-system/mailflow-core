// Named capabilities are the only thing routes check. Roles are bundles of these names, so a new
// role never needs a route change. Add a name here when a route or action starts enforcing it.
export const capabilities = [
  'mail.read',
  'mail.compose',
  'members.manage',
  'admins.manage',
  'workspace.manage',
] as const

export type Capability = (typeof capabilities)[number]

export function isCapability(value: string): value is Capability {
  return (capabilities as readonly string[]).includes(value)
}
