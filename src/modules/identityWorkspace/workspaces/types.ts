import type { MiddlewareHandler } from 'hono'
import type { Pool, PoolClient } from 'pg'
import type { AuthSession } from '../infrastructure/types/auth.js'
import type { AuthOriginPolicy } from '../infrastructure/types/authConfig.js'

export type WorkspaceSummary = {
  id: string
  name: string
  slug: string
  role: 'owner' | 'admin' | 'member'
}

export type WorkspacePage = { items: WorkspaceSummary[]; nextCursor: string | null }
export type WorkspacePool = Pick<Pool, 'connect'>
export type WorkspaceClient = Pick<PoolClient, 'query' | 'release'>
export type WorkspaceReader = {
  list: (userId: string, cursor?: string) => Promise<WorkspacePage>
  context: (userId: string, slug: string) => Promise<WorkspaceSummary | null>
}
export type WorkspaceSelection = {
  select: (userId: string, workspaceId: string) => Promise<WorkspaceSummary | null>
}
export type WorkspaceSelectionDependencies = {
  selection: WorkspaceSelection
  allowedOrigins: string[]
  isAllowedOrigin?: AuthOriginPolicy
  consumeBudget: DiscoveryBudget
}
export type WorkspaceRouteEnvironment = { Variables: { authSession: AuthSession } }
export type WorkspaceMiddleware = MiddlewareHandler<WorkspaceRouteEnvironment>
export type DiscoveryBudget = (userId: string) => Promise<number>
export type WorkspaceRouteDependencies = { reader: WorkspaceReader; consumeBudget: DiscoveryBudget }
export type DiscoveryBudgetRow = { count: number; last_request: string }
export type DatabaseRoleResult = { unsafe: boolean }
