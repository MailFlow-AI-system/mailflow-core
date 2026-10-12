import { loadAuthConfig } from './infrastructure/auth/authConfig.js'
import { createAuthOriginPolicy } from './infrastructure/auth/authOriginPolicy.js'
import { createAuth } from './infrastructure/auth/createAuth.js'
import { assertOnboardingDatabaseRole } from './onboarding/databaseRole.js'
import { createOnboardingOtpHandler } from './onboarding/otpHandler.js'
import { createOnboardingBudget } from './onboarding/requestBudget.js'
import {
  loadWorkspaceWebBaseOrigin,
  onboardingEnabled,
  signupCutoverEnabled,
} from './onboarding/runtimeConfig.js'
import { createOnboardingService } from './onboarding/service.js'
import { createOnboardingCipher } from './onboarding/utils/cipher.js'
import { createProtectedOtpStorage } from './onboarding/utils/otpStorage.js'
import type {
  IdentityWorkspaceRuntime,
  IdentityWorkspaceRuntimeDependencies,
} from './runtimeTypes.js'
import { assertWorkspaceDatabaseRole } from './workspaces/databaseRole.js'
import { createDiscoveryBudget } from './workspaces/discoveryBudget.js'
import { workspaceReadsEnabled, workspaceSwitchingMode } from './workspaces/runtimeConfig.js'
import { assertWorkspaceSelectionDatabaseRole } from './workspaces/selectionDatabaseRole.js'
import { createWorkspaceEntryReader } from './workspaces/workspaceEntryReader.js'
import { createWorkspaceReader } from './workspaces/workspaceReader.js'
import { createWorkspaceSelection } from './workspaces/workspaceSelection.js'

export async function createIdentityWorkspaceRuntime({
  environment,
  pool,
  database,
  authConfig = loadAuthConfig(environment),
  sendAccountEmail,
  reportEmailDeliveryFailure,
}: IdentityWorkspaceRuntimeDependencies): Promise<IdentityWorkspaceRuntime> {
  const reads = workspaceReadsEnabled(environment)
  const switchingMode = workspaceSwitchingMode(environment)
  const selection = switchingMode !== 'disabled'
  if (switchingMode === 'remote' && !authConfig.workspaceDeployment)
    throw new Error('Remote workspace switching requires validated deployment auth configuration')
  const isAllowedOrigin = createAuthOriginPolicy(authConfig)
  const onboarding = onboardingEnabled(environment)
  const closeLegacySignup = signupCutoverEnabled(environment)
  const webBaseOrigin = onboarding ? loadWorkspaceWebBaseOrigin(environment) : undefined
  if (reads) await assertWorkspaceDatabaseRole(pool)
  if (selection) await assertWorkspaceSelectionDatabaseRole(pool)
  if (onboarding) await assertOnboardingDatabaseRole(pool)
  const auth = createAuth(database, authConfig, sendAccountEmail, reportEmailDeliveryFailure, {
    ...(onboarding
      ? { otpStorage: createProtectedOtpStorage(createOnboardingCipher(authConfig.secret)) }
      : {}),
    ...(switchingMode === 'local' ? { localWorkspaceCookie: true } : {}),
  })
  return {
    auth,
    allowedAuthOrigins: authConfig.allowedOrigins,
    isAllowedAuthOrigin: isAllowedOrigin,
    ...(reads
      ? {
          workspaces: {
            reader: createWorkspaceReader(pool),
            consumeBudget: createDiscoveryBudget(pool),
          },
        }
      : {}),
    ...(selection
      ? {
          workspaceSelection: {
            selection: createWorkspaceSelection(pool),
            allowedOrigins: authConfig.allowedOrigins,
            isAllowedOrigin,
            consumeBudget: createDiscoveryBudget(pool),
          },
          workspaceEntry: {
            reader: createWorkspaceEntryReader(pool),
            consumeBudget: createDiscoveryBudget(pool),
          },
        }
      : {}),
    ...(webBaseOrigin
      ? {
          onboarding: {
            service: createOnboardingService(pool, authConfig),
            handleOtp: createOnboardingOtpHandler(pool, authConfig, webBaseOrigin),
            allowedOrigin: authConfig.siteURL,
            consumeBudget: createOnboardingBudget(pool, authConfig.secret),
            closeLegacySignup,
          },
        }
      : {}),
  }
}
