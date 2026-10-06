import { defineConfig } from 'drizzle-kit'

import { loadMigrationConfig } from '../../src/shared/database/migrationConfig.js'

const config = loadMigrationConfig(process.env)

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/mail/infrastructure/database/schema/**/*.ts',
  schemaFilter: 'mail',
  out: './database/migrations/mail',
  dbCredentials: {
    url: config.directUrl,
  },
  migrations: {
    schema: 'mail_migrations',
    table: '__drizzle_migrations',
  },
})
