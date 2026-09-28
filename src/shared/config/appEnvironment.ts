import { z } from 'zod'

export const appEnvironmentSchema = z.enum(['development', 'staging', 'production'])

export type AppEnvironment = z.infer<typeof appEnvironmentSchema>
