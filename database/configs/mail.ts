import { defineConfig } from 'drizzle-kit'

import { loadMigrationConfig } from '../../src/shared/database/migrationConfig.js'
import { migrationModules, migrationTable } from '../../src/shared/database/migrationModules.js'

const config = loadMigrationConfig(process.env)
const module = migrationModules.find((module) => module.name === 'mail')
if (!module) throw new Error('Missing mail migration module')

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/mail/infrastructure/database/schema/**/*.ts',
  schemaFilter: 'mail',
  out: `./database/migrations/${module.folder}`,
  dbCredentials: {
    url: config.directUrl,
  },
  migrations: {
    schema: module.schema,
    table: migrationTable,
  },
})
