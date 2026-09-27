import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { betterAuth } from 'better-auth'
import type { createDatabase } from '#shared/database/client'
import * as schema from '../database/schema/auth.js'
import type { AuthConfig } from './authConfig.js'

type Database = ReturnType<typeof createDatabase>['database']

const authSchema = {
  ...schema,
  user: schema.authUser,
  session: schema.authSession,
  account: schema.authAccount,
  verification: schema.authVerification,
}

export function createAuth(database: Database, config: AuthConfig) {
  return betterAuth({
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema: authSchema,
      schemaName: 'identity_workspace',
    }),
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: config.allowedOrigins,
    emailAndPassword: {
      enabled: true,
    },
  })
}
