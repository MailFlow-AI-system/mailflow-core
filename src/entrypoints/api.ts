import { serve } from '@hono/node-server'
import { createAuth } from '#modules/identityWorkspace'
import { createMailMessageRepository } from '#modules/mail'
import { loadConfig } from '#shared/config/env'
import { createDatabase } from '#shared/database/client'
import { createLogger, shutdownLogger } from '#shared/logging/logger'
import { startObservability } from '#shared/observability/observability'
import { waitForShutdown } from '#shared/runtime/waitForShutdown'
import { createApp } from '../app.js'
import { loadAuthConfig } from '../modules/identityWorkspace/infrastructure/auth/authConfig.js'

const config = loadConfig(process.env)
const authConfig = loadAuthConfig(process.env)
const telemetry = await startObservability(config, 'mailflow-core-api')
const logger = createLogger(config, telemetry.serviceName)
const database = createDatabase(config.databaseUrl, logger)
const auth = createAuth(database.database, authConfig, undefined, (operation) =>
  logger.error({ operation }, 'Account email delivery failed'),
)
const app = createApp({
  config,
  logger,
  observability: telemetry,
  checkDatabase: database.check,
  auth,
  allowedAuthOrigins: authConfig.allowedOrigins,
  mailRepository: createMailMessageRepository(database.database),
})

const server = serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
})

logger.info({ host: config.host, port: config.port }, 'API started')

const signal = await waitForShutdown()
logger.info({ signal }, 'API shutdown started')

const forceShutdown = setTimeout(() => {
  logger.warn('API graceful shutdown timed out')
  if ('closeAllConnections' in server) {
    server.closeAllConnections()
  }
}, 10_000)
forceShutdown.unref()

try {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
} finally {
  clearTimeout(forceShutdown)
  await database.pool.end()
  logger.info('API shutdown completed')
  await shutdownLogger(logger)
  await telemetry.shutdown()
}
