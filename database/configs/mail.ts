import { defineConfig } from 'drizzle-kit'

import { loadConfig } from '../../src/shared/config/env.js'

const config = loadConfig(process.env)

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/mail/infrastructure/database/schema/**/*.ts',
  schemaFilter: 'mail',
  out: './database/migrations/mail',
  dbCredentials: {
    url: config.databaseUrl,
  },
  migrations: {
    schema: 'mail_migrations',
    table: '__drizzle_migrations',
  },
})
