import { loadConfig } from '#shared/config/env'
import { createDatabase } from '#shared/database/client'
import { createLogger, shutdownLogger } from '#shared/logging/logger'
import { startObservability } from '#shared/observability/observability'
import { createWorkerLifecycleMetrics } from '#shared/observability/workerMetrics'
import { waitForShutdown } from '#shared/runtime/waitForShutdown'
import { createAccountEmailSender } from '../modules/identityWorkspace/accountEmails/index.js'
import { loadAuthConfig } from '../modules/identityWorkspace/infrastructure/auth/authConfig.js'
import { assertOnboardingDatabaseRole } from '../modules/identityWorkspace/onboarding/databaseRole.js'
import { createOnboardingDispatcher } from '../modules/identityWorkspace/onboarding/dispatcher.js'
import { createQueuedEmailTransport } from '../modules/identityWorkspace/onboarding/queuedTransport.js'
import { onboardingDeliveryEnabled } from '../modules/identityWorkspace/onboarding/runtimeConfig.js'
import { createOnboardingCipher } from '../modules/identityWorkspace/onboarding/utils/cipher.js'
import { runOnboardingWorker } from '../modules/identityWorkspace/onboarding/worker.js'

const config = loadConfig(process.env)
const telemetry = await startObservability(config, 'mailflow-core-worker')
const logger = createLogger(config, telemetry.serviceName)
const database = createDatabase(config.databaseUrl, logger)
const workerMetrics = createWorkerLifecycleMetrics(telemetry.meter)
const deliveryEnabled = onboardingDeliveryEnabled(process.env)
const controller = new AbortController()
let deliveryLoop: Promise<void> | undefined
if (deliveryEnabled) {
  const authConfig = loadAuthConfig(process.env)
  await assertOnboardingDatabaseRole(database.pool)
  const dispatch = createOnboardingDispatcher({
    pool: database.pool,
    cipher: createOnboardingCipher(authConfig.secret),
    send: createAccountEmailSender(
      authConfig,
      createQueuedEmailTransport(authConfig.resend.apiKey),
    ),
  })
  deliveryLoop = runOnboardingWorker({
    dispatch,
    signal: controller.signal,
    report: (outcome) => {
      if (outcome === 'failed')
        logger.error({ operation: 'onboarding-email' }, 'Onboarding delivery failed')
      else if (outcome !== 'idle')
        logger.info({ outcome, operation: 'onboarding-email' }, 'Onboarding delivery processed')
    },
  })
}

workerMetrics.started()
logger.info({ onboardingDelivery: deliveryEnabled }, 'Worker started')

const signal = await waitForShutdown()
logger.info({ signal }, 'Worker shutdown started')

try {
  controller.abort()
  await deliveryLoop
  await database.pool.end()
} finally {
  workerMetrics.stopped()
  logger.info('Worker shutdown completed')
  await shutdownLogger(logger)
  await telemetry.shutdown()
}
