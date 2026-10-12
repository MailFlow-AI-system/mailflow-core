export { createAuth } from './infrastructure/auth/createAuth.js'
export { installAuthRoutes } from './infrastructure/auth/route.js'
export type { AuthService } from './infrastructure/types/auth.js'
export { createOnboardingOtpHandler } from './onboarding/otpHandler.js'
export { createOnboardingBudget } from './onboarding/requestBudget.js'
export { createOnboardingRoutes } from './onboarding/route.js'
export { createOnboardingService } from './onboarding/service.js'
export type { OnboardingRouteDependencies } from './onboarding/types.js'
export { createIdentityWorkspaceRuntime } from './runtime.js'
export type {
  IdentityWorkspaceRuntime,
  IdentityWorkspaceRuntimeDependencies,
  IdentityWorkspaceWorkerDependencies,
} from './runtimeTypes.js'
export { startIdentityWorkspaceWorker } from './workerRuntime.js'
export { assertWorkspaceDatabaseRole } from './workspaces/databaseRole.js'
export { createDiscoveryBudget } from './workspaces/discoveryBudget.js'
export { createWorkspaceEntryRoutes } from './workspaces/entryRoute.js'
export type { WorkspaceEntryDependencies } from './workspaces/entryTypes.js'
export { createWorkspaceRoutes } from './workspaces/route.js'
export {
  workspaceLocalSwitchingEnabled,
  workspaceReadsEnabled,
} from './workspaces/runtimeConfig.js'
export { assertWorkspaceSelectionDatabaseRole } from './workspaces/selectionDatabaseRole.js'
export { createWorkspaceSelectionRoutes } from './workspaces/selectionRoute.js'
export type {
  WorkspaceReader,
  WorkspaceRouteDependencies,
  WorkspaceSelectionDependencies,
} from './workspaces/types.js'
export { createWorkspaceEntryReader } from './workspaces/workspaceEntryReader.js'
export { createWorkspaceReader } from './workspaces/workspaceReader.js'
export { createWorkspaceSelection } from './workspaces/workspaceSelection.js'
