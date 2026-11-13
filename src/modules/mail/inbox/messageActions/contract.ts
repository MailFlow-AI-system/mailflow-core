import { z } from '@hono/zod-openapi'

export const mailFolders = ['inbox', 'starred', 'archive', 'trash', 'spam'] as const
export type MailFolder = (typeof mailFolders)[number]
/** The folder a message lives in; `starred` is a per-user view, not a location. */
export type MessageLocation = Exclude<MailFolder, 'starred'>

export const MESSAGE_ACTION_LIMIT = 100

export const messageActions = [
  'read',
  'unread',
  'star',
  'unstar',
  'archive',
  'unarchive',
  'trash',
  'restore',
  'spam',
  'not_spam',
  'delete_permanently',
] as const
export type MessageAction = (typeof messageActions)[number]
export type MessageStateAction = Exclude<MessageAction, 'delete_permanently'>

export const messagePatchSchema = z
  .strictObject({
    read: z.boolean().optional(),
    starred: z.boolean().optional(),
    archived: z.boolean().optional(),
    trashed: z.boolean().optional(),
    spam: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'At least one field is required')
export type MessagePatch = z.infer<typeof messagePatchSchema>

export const messageActionsSchema = z.strictObject({
  ids: z
    .array(z.uuid())
    .min(1)
    .max(MESSAGE_ACTION_LIMIT)
    // PostgreSQL compares UUIDs case-insensitively, so duplicates are detected the same way.
    .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]),
  action: z.enum(messageActions),
})

export type MessageActionStatus = 'ok' | 'not_found' | 'invalid_state'
export type MessageActionResult = { id: string; status: MessageActionStatus }

const patches: Record<MessageStateAction, MessagePatch> = {
  read: { read: true },
  unread: { read: false },
  star: { starred: true },
  unstar: { starred: false },
  archive: { archived: true },
  unarchive: { archived: false },
  trash: { trashed: true },
  restore: { trashed: false },
  spam: { spam: true },
  not_spam: { spam: false },
}

export function actionPatch(action: MessageStateAction): MessagePatch {
  return patches[action]
}

/** Archive, trash and spam are shared by the whole workspace and require mail.compose. */
export function changesWorkspaceState(patch: MessagePatch) {
  return patch.archived !== undefined || patch.trashed !== undefined || patch.spam !== undefined
}

export function folderOf(state: {
  archivedAt: string | null
  trashedAt: string | null
  spamAt: string | null
}): MessageLocation {
  if (state.trashedAt) return 'trash'
  if (state.spamAt) return 'spam'
  if (state.archivedAt) return 'archive'
  return 'inbox'
}
