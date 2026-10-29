import { parseArgs } from 'node:util'
import type { MailWorkspaceAuthority, WorkspaceReader } from '#modules/identityWorkspace'

type MailSeedEnvironment = {
  appEnv: string | undefined
  nodeEnv?: string | undefined
  railwayEnvironmentId?: string | undefined
}
type MailSeedSelectors = {
  workspaceId?: string | undefined
  workspaceName?: string | undefined
  workspaceSlug?: string | undefined
}
export type MailSeedTarget = MailSeedSelectors & { workspaceOwnerId: string }

export function parseMailSeedTarget(
  input: MailSeedEnvironment & MailSeedSelectors & { workspaceOwnerId: string | undefined },
): MailSeedTarget {
  if (
    input.appEnv !== 'development' ||
    input.nodeEnv === 'production' ||
    input.railwayEnvironmentId
  )
    throw new Error('Mail QA seed requires APP_ENV=development')
  if (!input.workspaceOwnerId || input.workspaceOwnerId.trim() !== input.workspaceOwnerId)
    throw new Error('Mail QA seed requires an unambiguous --workspace-owner-id')
  const selectors = Object.entries({
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    workspaceSlug: input.workspaceSlug,
  }).filter(([, value]) => value !== undefined)
  if (selectors.length !== 1)
    throw new Error(
      'Mail QA seed requires exactly one of --workspace-id, --workspace-name, or --workspace-slug',
    )
  const selector = selectors[0]
  if (!selector?.[1] || selector[1].trim() !== selector[1])
    throw new Error('Mail QA seed requires an unambiguous workspace selector')
  if (
    input.workspaceSlug !== undefined &&
    (input.workspaceSlug.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.workspaceSlug))
  )
    throw new Error('Mail QA seed requires a valid DNS workspace slug')
  return { [selector[0]]: selector[1], workspaceOwnerId: input.workspaceOwnerId }
}

export function parseMailSeedArgs(
  args: string[],
  environment: MailSeedEnvironment,
): MailSeedTarget {
  for (const name of ['workspace-id', 'workspace-name', 'workspace-slug', 'workspace-owner-id']) {
    const option = `--${name}`
    if (
      args.filter((argument) => argument === option || argument.startsWith(`${option}=`)).length > 1
    )
      throw new Error(`Mail QA seed accepts --${name} only once`)
  }
  const { values } = parseArgs({
    args,
    options: {
      'workspace-id': { type: 'string' },
      'workspace-name': { type: 'string' },
      'workspace-slug': { type: 'string' },
      'workspace-owner-id': { type: 'string' },
    },
  })
  return parseMailSeedTarget({
    ...environment,
    workspaceId: values['workspace-id'],
    workspaceName: values['workspace-name'],
    workspaceSlug: values['workspace-slug'],
    workspaceOwnerId: values['workspace-owner-id'],
  })
}

export async function resolveMailSeedWorkspaceId(
  authority: MailWorkspaceAuthority,
  target: MailSeedTarget,
  reader?: Pick<WorkspaceReader, 'list'>,
): Promise<string> {
  let workspaceId = target.workspaceId
  if (target.workspaceName !== undefined) {
    if (!reader) throw new Error('Mail QA workspace name lookup requires a workspace reader')
    let cursor: string | undefined
    do {
      const page = await reader.list(target.workspaceOwnerId, cursor)
      for (const workspace of page.items) {
        if (workspace.name !== target.workspaceName) continue
        if (workspaceId !== undefined)
          throw new Error('Mail QA workspace name is ambiguous; use --workspace-id')
        workspaceId = workspace.id
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    if (workspaceId === undefined)
      throw new Error('Mail QA target workspace was not found for the supplied owner')
  }
  const selection =
    workspaceId !== undefined
      ? { workspaceId }
      : target.workspaceSlug !== undefined
        ? { slug: target.workspaceSlug }
        : undefined
  if (!selection) throw new Error('Mail QA seed requires an explicit workspace selector')
  const result = await authority.resolve(target.workspaceOwnerId, selection)
  if (
    result.status !== 'ok' ||
    (workspaceId !== undefined && result.workspace.id !== workspaceId) ||
    (target.workspaceName !== undefined && result.workspace.name !== target.workspaceName) ||
    (target.workspaceSlug !== undefined && result.workspace.slug !== target.workspaceSlug)
  )
    throw new Error('Mail QA target workspace was not found for the supplied owner')
  if (result.workspace.role !== 'owner')
    throw new Error('Mail QA target workspace requires its existing owner identity')
  return result.workspace.id
}
