import { z } from 'zod'

const flag = z.enum(['true', 'false']).default('false')

// Workspace hosting serves each workspace from `{slug}.{WORKSPACE_WEB_BASE_ORIGIN host}` with
// host-only session cookies; one-time handoff codes move a signed-in user between hosts.
export function workspaceSwitchingEnabled(environment: NodeJS.ProcessEnv) {
  const enabled = flag.parse(environment.WORKSPACE_SWITCHING_ENABLED) === 'true'
  if (enabled && !workspaceReadsEnabled(environment))
    throw new Error('Workspace switching requires authorized workspace reads')
  return enabled
}

export function workspaceReadsEnabled(environment: NodeJS.ProcessEnv) {
  return flag.parse(environment.WORKSPACE_READ_ENABLED) === 'true'
}
