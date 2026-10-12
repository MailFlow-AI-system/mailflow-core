import { createAccountEmailSender } from './accountEmails/index.js'
import { loadAuthConfig } from './infrastructure/auth/authConfig.js'
import { assertOnboardingDatabaseRole } from './onboarding/databaseRole.js'
import { createOnboardingDispatcher } from './onboarding/dispatcher.js'
import { createQueuedEmailTransport } from './onboarding/queuedTransport.js'
import { onboardingDeliveryEnabled } from './onboarding/runtimeConfig.js'
import { createOnboardingCipher } from './onboarding/utils/cipher.js'
import { runOnboardingWorker } from './onboarding/worker.js'
import type { IdentityWorkspaceWorkerDependencies } from './runtimeTypes.js'

export async function startIdentityWorkspaceWorker({
  environment,
  pool,
  signal,
  report,
}: IdentityWorkspaceWorkerDependencies) {
  const enabled = onboardingDeliveryEnabled(environment)
  if (!enabled) return { enabled, completion: undefined }
  const authConfig = loadAuthConfig(environment)
  await assertOnboardingDatabaseRole(pool)
  const dispatch = createOnboardingDispatcher({
    pool,
    cipher: createOnboardingCipher(authConfig.secret),
    send: createAccountEmailSender(
      authConfig,
      createQueuedEmailTransport(authConfig.resend.apiKey),
    ),
  })
  return { enabled, completion: runOnboardingWorker({ dispatch, signal, report }) }
}
