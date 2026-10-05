import type { DiscoveryBudget, WorkspaceSummary } from './types.js'

export type WorkspaceEntry =
  | { source: 'preference' | 'fallback'; workspace: WorkspaceSummary }
  | { source: 'none'; workspace: null }
export type WorkspaceEntryRow = WorkspaceSummary & { source: 'preference' | 'fallback' }
export type WorkspaceEntryReader = { resolve: (userId: string) => Promise<WorkspaceEntry> }
export type WorkspaceEntryDependencies = {
  reader: WorkspaceEntryReader
  consumeBudget: DiscoveryBudget
}
