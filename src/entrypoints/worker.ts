import { loadConfig } from '#shared/config/env'
import { createDatabase } from '#shared/database/client'
import { createLogger, flushLogger } from '#shared/logging/logger'
import { startObservability } from '#shared/observability/observability'
import { createWorkerLifecycleMetrics } from '#shared/observability/workerMetrics'
import { waitForShutdown } from '#shared/runtime/waitForShutdown'

const config = loadConfig(process.env)
const telemetry = await startObservability(config, 'mailflow-core-worker')
const logger = createLogger(config, telemetry.serviceName)
const database = createDatabase(config.databaseUrl, logger)
const workerMetrics = createWorkerLifecycleMetrics(telemetry.meter)

workerMetrics.started()
logger.info('Worker started without job handlers')

const signal = await waitForShutdown()
logger.info({ signal }, 'Worker shutdown started')

try {
  await database.pool.end()
} finally {
  workerMetrics.stopped()
  logger.info('Worker shutdown completed')
  await flushLogger(logger)
  await telemetry.shutdown()
}
