import { z } from 'zod'

export function workspaceReadsEnabled(environment: NodeJS.ProcessEnv) {
  return (
    z.enum(['true', 'false']).default('false').parse(environment.WORKSPACE_READ_ENABLED) === 'true'
  )
}
