import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { betterAuth } from 'better-auth'
import type { createDatabase } from '#shared/database/client'
import { authAccount } from '../database/schema/auth/account.js'
import { authSession } from '../database/schema/auth/session.js'
import { authUser } from '../database/schema/auth/user.js'
import { authVerification } from '../database/schema/auth/verification.js'
import type { AuthConfig } from './authConfig.js'

type Database = ReturnType<typeof createDatabase>['database']

const authSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
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
