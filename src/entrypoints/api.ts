import { serve } from '@hono/node-server'
import { loadConfig } from '#shared/config/env'
import { createDatabase } from '#shared/database/client'
import { createLogger } from '#shared/logging/logger'
import { waitForShutdown } from '#shared/runtime/waitForShutdown'
import { createApp } from '../app.js'

const config = loadConfig(process.env)
const logger = createLogger(config)
const database = createDatabase(config.databaseUrl, logger)
const app = createApp({ config, logger, checkDatabase: database.check })

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
  await database.pool.end()
  logger.info('API shutdown completed')
} finally {
  clearTimeout(forceShutdown)
}
