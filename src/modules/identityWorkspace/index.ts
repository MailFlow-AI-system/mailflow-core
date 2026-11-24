export type { Capability } from './authorization/capabilities.js'
export { capabilities } from './authorization/capabilities.js'
export type { MemberRole, PredefinedRole } from './authorization/roles.js'
export {
  memberRoles,
  predefinedRoles,
  resolveCapabilities,
  roleLabels,
} from './authorization/roles.js'
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
export type {
  MailWorkspaceAuthority,
  MailWorkspaceResolution,
  MailWorkspaceSelection,
} from './workspaces/mailWorkspaceAuthority.js'
export { createMailWorkspaceAuthority } from './workspaces/mailWorkspaceAuthority.js'
export { createWorkspaceRoutes } from './workspaces/route.js'
export {
  workspaceReadsEnabled,
  workspaceSwitchingEnabled,
} from './workspaces/runtimeConfig.js'
export { assertWorkspaceSelectionDatabaseRole } from './workspaces/selectionDatabaseRole.js'
export type {
  WorkspaceAccess,
  WorkspaceReader,
  WorkspaceRouteDependencies,
  WorkspaceSummary,
} from './workspaces/types.js'
export { createWorkspaceReader } from './workspaces/workspaceReader.js'
export { createWorkspaceSelection } from './workspaces/workspaceSelection.js'
