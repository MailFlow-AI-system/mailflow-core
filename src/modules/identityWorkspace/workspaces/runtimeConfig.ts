import { z } from 'zod'
import type { WorkspaceSwitchingMode } from './configTypes.js'

export function workspaceSwitchingMode(environment: NodeJS.ProcessEnv): WorkspaceSwitchingMode {
  const local = workspaceLocalSwitchingEnabled(environment)
  const remote =
    z.enum(['true', 'false']).default('false').parse(environment.WORKSPACE_SWITCHING_ENABLED) ===
    'true'
  if (local && remote)
    throw new Error('Local and remote workspace switching are mutually exclusive')
  if (remote && !workspaceReadsEnabled(environment))
    throw new Error('Remote workspace switching requires authorized workspace reads')
  return remote ? 'remote' : local ? 'local' : 'disabled'
}

export function workspaceReadsEnabled(environment: NodeJS.ProcessEnv) {
  return (
    z.enum(['true', 'false']).default('false').parse(environment.WORKSPACE_READ_ENABLED) === 'true'
  )
}

export function workspaceLocalSwitchingEnabled(environment: NodeJS.ProcessEnv) {
  const enabled =
    z
      .enum(['true', 'false'])
      .default('false')
      .parse(environment.WORKSPACE_LOCAL_SWITCHING_ENABLED) === 'true'
  if (enabled && (environment.APP_ENV !== 'development' || !workspaceReadsEnabled(environment)))
    throw new Error(
      'Local workspace switching requires development with authorized workspace reads',
    )
  return enabled
}
