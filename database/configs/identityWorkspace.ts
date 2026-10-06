import { defineConfig } from 'drizzle-kit'

import { loadMigrationConfig } from '../../src/shared/database/migrationConfig.js'

const config = loadMigrationConfig(process.env)

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/identityWorkspace/infrastructure/database/schema/**/*.ts',
  schemaFilter: 'identity_workspace',
  out: './database/migrations/identityWorkspace',
  dbCredentials: {
    url: config.directUrl,
  },
  migrations: {
    schema: 'identity_workspace_migrations',
    table: '__drizzle_migrations',
  },
})
