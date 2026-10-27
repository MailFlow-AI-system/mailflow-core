import { serve } from '@hono/node-server'
import { createIdentityWorkspaceRuntime } from '#modules/identityWorkspace'
import {
  assertMailDatabaseRole,
  cleanupAttachments,
  cleanupOrphanObjects,
  createAttachmentRepository,
  createAttachmentService,
  createMailMessageRepository,
  createObjectStorage,
  createOutgoingRepository,
  createResendDelivery,
  startAttachmentCleanupScheduler,
} from '#modules/mail'
import { loadConfig } from '#shared/config/env'
import { createDatabase } from '#shared/database/client'
import { createLogger, shutdownLogger } from '#shared/logging/logger'
import { startObservability } from '#shared/observability/observability'
import { waitForShutdown } from '#shared/runtime/waitForShutdown'
import { createApp } from '../app.js'

const config = loadConfig(process.env)
const telemetry = await startObservability(config, 'mailflow-core-api')
const logger = createLogger(config, telemetry.serviceName)
const database = createDatabase(config.databaseUrl, logger)
const identityWorkspace = await createIdentityWorkspaceRuntime({
  environment: process.env,
  pool: database.pool,
  database: database.database,
  reportEmailDeliveryFailure: (operation) =>
    logger.error({ operation }, 'Account email delivery failed'),
})
if (identityWorkspace.workspaces) await assertMailDatabaseRole(database.pool)
const attachmentRepository = createAttachmentRepository(database.database)
const objectStorage = createObjectStorage(process.env)
const attachments = createAttachmentService({
  repository: attachmentRepository,
  storage: objectStorage,
})
const outgoingRepository = createOutgoingRepository(database.database)
const app = createApp({
  config,
  logger,
  observability: telemetry,
  checkDatabase: database.check,
  ...identityWorkspace,
  mailRepository: createMailMessageRepository(database.pool),
  attachments,
  outgoingMail: {
    repository: outgoingRepository,
    deliver: createResendDelivery(process.env),
    resolveAttachments: attachments.resolveReferences,
  },
})

const server = serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
})

logger.info({ host: config.host, port: config.port }, 'API started')
const stopAttachmentCleanup = startAttachmentCleanupScheduler({
  cleanupBatch: async () => {
    await outgoingRepository.cleanupAbandoned()
    return cleanupAttachments(attachmentRepository, objectStorage)
  },
  cleanupPage: (cursor) => cleanupOrphanObjects(attachmentRepository, objectStorage, cursor),
  reportSummary: (summary) => logger.info(summary, 'Attachment cleanup completed'),
  reportFailure: (phase) => logger.error({ phase }, 'Attachment cleanup failed'),
})

const signal = await waitForShutdown()
logger.info({ signal }, 'API shutdown started')
const cleanupStopped = stopAttachmentCleanup()

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
  await cleanupStopped
  await database.pool.end()
  logger.info('API shutdown completed')
  await shutdownLogger(logger)
  await telemetry.shutdown()
}
