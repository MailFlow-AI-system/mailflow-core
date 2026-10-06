import { defineConfig } from 'drizzle-kit'

import { loadMigrationConfig } from '../../src/shared/database/migrationConfig.js'
import { migrationModules, migrationTable } from '../../src/shared/database/migrationModules.js'

const config = loadMigrationConfig(process.env)
const module = migrationModules.find((module) => module.name === 'identity-workspace')
if (!module) throw new Error('Missing identity-workspace migration module')

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/identityWorkspace/infrastructure/database/schema/**/*.ts',
  schemaFilter: 'identity_workspace',
  out: `./database/migrations/${module.folder}`,
  dbCredentials: {
    url: config.directUrl,
  },
  migrations: {
    schema: module.schema,
    table: migrationTable,
  },
})
