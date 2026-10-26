import { randomUUID } from 'node:crypto'
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
      if (await repository.isAssociated(record.userId, record.id)) continue
      await storage.delete(record.temporaryKey)
      if (record.finalKey) await storage.delete(record.finalKey)
      if (await repository.deleteClaimed(record.userId, record.id, token)) deleted++
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
    if (!(await repository.isFinalKeyReferenced(key))) {
      await storage.delete(key)
      deleted++
    }
  }
  return { deleted, nextCursor: page.nextCursor }
}
