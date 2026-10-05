import { z } from 'zod'

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
