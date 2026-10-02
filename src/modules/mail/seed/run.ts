import { loadConfig } from '#shared/config/env'
import { createDatabase } from '#shared/database/client'
import { createLogger, shutdownLogger } from '#shared/logging/logger'
import { seedMail } from './seedMail.js'

const config = loadConfig(process.env)
const logger = createLogger(config, 'mailflow-core-mail-seed')
const database = createDatabase(config.databaseUrl, logger)

try {
  const inserted = await seedMail(database.database)
  logger.info({ inserted }, 'Fictional inbox messages seeded')
} finally {
  await database.pool.end()
  await shutdownLogger(logger)
}
