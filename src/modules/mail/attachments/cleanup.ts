import { randomUUID } from 'node:crypto'
import { parseMailFinalKey } from './attachmentKeys.js'
import type { AttachmentRepository, ObjectStorage } from './types.js'

export async function cleanupAttachments(
  repository: Pick<AttachmentRepository, 'claimExpired' | 'deleteClaimed' | 'isAssociated'>,
  storage: Pick<ObjectStorage, 'delete'>,
) {
  const token = randomUUID()
  const records = await repository.claimExpired(100, token)
  let deleted = 0
  for (const record of records) {
    try {
      if (!record.workspaceId) continue
      const context = { workspaceId: record.workspaceId, userId: record.userId }
      if (await repository.isAssociated(context, record.id)) continue
      await storage.delete(record.temporaryKey)
      if (record.finalKey) await storage.delete(record.finalKey)
      if (await repository.deleteClaimed(context, record.id, token)) deleted++
    } catch {
      // The lease expires so a later cleanup can retry the same objects.
    }
  }
  return deleted
}

export async function cleanupOrphanObjects(
  repository: Pick<AttachmentRepository, 'isFinalKeyReferenced'>,
  storage: Pick<ObjectStorage, 'listOldFinalKeys' | 'delete'>,
  cursor?: string,
) {
  const page = await storage.listOldFinalKeys(cursor)
  let deleted = 0
  for (const key of page.keys) {
    const scope = parseMailFinalKey(key)
    if (!scope) continue
    if (!(await repository.isFinalKeyReferenced(key, scope.workspaceId ?? undefined))) {
      await storage.delete(key)
      deleted++
    }
  }
  return { deleted, nextCursor: page.nextCursor }
}
