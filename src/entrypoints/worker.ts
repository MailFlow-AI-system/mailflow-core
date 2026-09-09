import { loadConfig } from '#shared/config/env'
import { createDatabase } from '#shared/database/client'
import { createLogger } from '#shared/logging/logger'
import { waitForShutdown } from '#shared/runtime/waitForShutdown'

const config = loadConfig(process.env)
const logger = createLogger(config)
const database = createDatabase(config.databaseUrl)

logger.info('Worker started without job handlers')

const signal = await waitForShutdown()
logger.info({ signal }, 'Worker shutdown started')

await database.pool.end()
logger.info('Worker shutdown completed')
