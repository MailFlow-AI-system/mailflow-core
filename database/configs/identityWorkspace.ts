import { defineConfig } from 'drizzle-kit'

import { loadConfig } from '../../src/shared/config/env.js'

const config = loadConfig(process.env)

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/identityWorkspace/infrastructure/database/schema/**/*.ts',
  schemaFilter: 'identity_workspace',
  out: './database/migrations/identityWorkspace',
  dbCredentials: {
    url: config.databaseUrl,
  },
  migrations: {
    schema: 'identity_workspace_migrations',
    table: '__drizzle_migrations',
  },
})
