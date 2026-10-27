import type { MailContext } from '../context/types.js'

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const scopedFinal = new RegExp(`^workspaces/([^/]+)/mail/attachments/(${uuid})/(${uuid})$`)
const legacyFinal = new RegExp(`^objects/owners/[a-f0-9]{64}/${uuid}/${uuid}$`)

export function temporaryAttachmentKey(context: MailContext, id: string) {
  return `uploads/${encodeURIComponent(context.workspaceId)}/mail/attachments/${id}`
}

export function finalAttachmentKey(context: MailContext, id: string, version: string) {
  return `workspaces/${encodeURIComponent(context.workspaceId)}/mail/attachments/${id}/${version}`
}

export function parseMailFinalKey(key: string): { workspaceId: string | null } | null {
  const scoped = scopedFinal.exec(key)
  if (scoped?.[1]) {
    try {
      const workspaceId = decodeURIComponent(scoped[1])
      if (workspaceId && encodeURIComponent(workspaceId) === scoped[1]) return { workspaceId }
    } catch {
      return null
    }
  }
  return legacyFinal.test(key) ? { workspaceId: null } : null
}
