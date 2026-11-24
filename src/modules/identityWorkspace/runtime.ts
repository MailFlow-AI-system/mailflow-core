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
import { createAccountWorkspaceResolver } from './workspaces/accountWorkspace.js'
import { assertWorkspaceDatabaseRole } from './workspaces/databaseRole.js'
import { createDiscoveryBudget } from './workspaces/discoveryBudget.js'
import { createMailWorkspaceAuthority } from './workspaces/mailWorkspaceAuthority.js'
import { workspaceReadsEnabled, workspaceSwitchingEnabled } from './workspaces/runtimeConfig.js'
import { assertWorkspaceSelectionDatabaseRole } from './workspaces/selectionDatabaseRole.js'
import { createWorkspaceHandoffStore } from './workspaces/workspaceHandoff.js'
import { createWorkspaceReader } from './workspaces/workspaceReader.js'

export async function createIdentityWorkspaceRuntime({
  environment,
  pool,
  database,
  authConfig = loadAuthConfig(environment),
  sendAccountEmail,
  reportEmailDeliveryFailure,
}: IdentityWorkspaceRuntimeDependencies): Promise<IdentityWorkspaceRuntime> {
  const reads = workspaceReadsEnabled(environment)
  const selection = workspaceSwitchingEnabled(environment)
  if (selection && !authConfig.workspaceDeployment)
    throw new Error('Workspace switching requires validated workspace hosting configuration')
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
    ...(selection
      ? {
          accountWorkspace: createAccountWorkspaceResolver(pool),
          workspaceHandoff: createWorkspaceHandoffStore(pool),
        }
      : {}),
  })
  return {
    auth,
    mailWorkspaceAuthority: createMailWorkspaceAuthority(pool),
    ...(environment.WORKSPACE_WEB_BASE_ORIGIN
      ? { mailWorkspaceBaseOrigin: loadWorkspaceWebBaseOrigin(environment) }
      : {}),
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
