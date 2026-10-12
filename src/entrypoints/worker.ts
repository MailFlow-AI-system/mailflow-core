import { startIdentityWorkspaceWorker } from '#modules/identityWorkspace'
import { loadConfig } from '#shared/config/env'
import { createDatabase } from '#shared/database/client'
import { createLogger, shutdownLogger } from '#shared/logging/logger'
import { startObservability } from '#shared/observability/observability'
import { createWorkerLifecycleMetrics } from '#shared/observability/workerMetrics'
import { waitForShutdown } from '#shared/runtime/waitForShutdown'

const config = loadConfig(process.env)
const telemetry = await startObservability(config, 'mailflow-core-worker')
const logger = createLogger(config, telemetry.serviceName)
const database = createDatabase(config.databaseUrl, logger)
const workerMetrics = createWorkerLifecycleMetrics(telemetry.meter)
const controller = new AbortController()
const delivery = await startIdentityWorkspaceWorker({
  environment: process.env,
  pool: database.pool,
  signal: controller.signal,
  report: (outcome) => {
    if (outcome === 'failed')
      logger.error({ operation: 'onboarding-email' }, 'Onboarding delivery failed')
    else if (outcome !== 'idle')
      logger.info({ outcome, operation: 'onboarding-email' }, 'Onboarding delivery processed')
  },
})

workerMetrics.started()
logger.info({ onboardingDelivery: delivery.enabled }, 'Worker started')

const signal = await waitForShutdown()
logger.info({ signal }, 'Worker shutdown started')

try {
  controller.abort()
  await delivery.completion
  await database.pool.end()
} finally {
  workerMetrics.stopped()
  logger.info('Worker shutdown completed')
  await shutdownLogger(logger)
  await telemetry.shutdown()
}
