import { z } from 'zod'

const directUrlSchema = z.url({ protocol: /^postgres(ql)?$/ }).refine((value) => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return (
    url.hostname.length > 0 &&
    url.pathname.length > 1 &&
    !(url.hostname.endsWith('.neon.tech') && url.hostname.includes('-pooler'))
  )
})

export function loadMigrationConfig(environment: NodeJS.ProcessEnv) {
  const parsed = directUrlSchema.safeParse(environment.DIRECT_URL)
  if (!parsed.success) {
    throw new Error('DIRECT_URL must be a valid direct PostgreSQL connection URL')
  }
  return { directUrl: parsed.data }
}
