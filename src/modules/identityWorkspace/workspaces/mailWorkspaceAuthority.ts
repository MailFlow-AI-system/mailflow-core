import { resolveCapabilities } from '../authorization/roles.js'
import { inIdentityTransaction } from './identityTransaction.js'
import type { WorkspaceAccess, WorkspacePool, WorkspaceSummary } from './types.js'

export type MailWorkspaceSelection = { workspaceId?: string; slug?: string }
export type MailWorkspaceResolution =
  | { status: 'ok'; workspace: WorkspaceAccess }
  | { status: 'required' }
  | { status: 'unavailable' }
export type MailWorkspaceAuthority = {
  resolve: (userId: string, selection?: MailWorkspaceSelection) => Promise<MailWorkspaceResolution>
}
type Candidate = WorkspaceSummary & { preferred: boolean; custom_capabilities: string[] | null }

export function createMailWorkspaceAuthority(pool: WorkspacePool): MailWorkspaceAuthority {
  return {
    resolve: (userId, selection = {}) =>
      inIdentityTransaction(pool, userId, async (client) => {
        const result = await client.query<Candidate>(
          `select o.id, o.name, o.slug, m.role, coalesce(p.workspace_id = o.id, false) as preferred,
           r.capabilities as custom_capabilities
         from identity_workspace.organization o
         join identity_workspace.member m on m.organization_id = o.id
         left join identity_workspace.workspace_role r on r.id = m.custom_role_id
         left join identity_workspace.workspace_preference p on p.user_id = m.user_id
         where m.user_id = $1 and ($2::text is null or o.id = $2)
           and ($3::text is null or o.slug = $3)
         order by preferred desc, o.id limit 2`,
          [userId, selection.workspaceId ?? null, selection.slug ?? null],
        )
        const selected = result.rows[0]
        if (!selected)
          return { status: selection.workspaceId || selection.slug ? 'unavailable' : 'required' }
        if (
          !selection.workspaceId &&
          !selection.slug &&
          result.rows.length > 1 &&
          !selected.preferred
        )
          return { status: 'required' }
        const { preferred: _, custom_capabilities: custom, ...workspace } = selected
        return {
          status: 'ok',
          workspace: { ...workspace, capabilities: resolveCapabilities(workspace.role, custom) },
        }
      }),
  }
}
