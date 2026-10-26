import { createHash, randomUUID } from 'node:crypto'
import { UnsupportedArchiveError, validateArchives } from './archiveValidation.js'
import { validImageContent } from './imageValidation.js'
import {
  type AttachmentMetadata,
  AttachmentMismatchError,
  type AttachmentRepository,
  type AttachmentScanner,
  type AttachmentView,
  type ObjectStorage,
} from './types.js'

export function createAttachmentService({
  repository,
  storage,
  scanner,
}: {
  repository: AttachmentRepository
  storage: ObjectStorage
  scanner: AttachmentScanner
}) {
  let activeCompletions = 0
  async function getView(userId: string, id: string): Promise<AttachmentView | null> {
    const record = await repository.get(userId, id)
    if (!record || record.status === 'deleting') return null
    const associated = await repository.isAssociated(userId, id)
    return {
      ...record,
      associated,
      status: record.expiresAt.getTime() <= Date.now() && !associated ? 'expired' : record.status,
    }
  }
  return {
    async create(userId: string, metadata: AttachmentMetadata) {
      const id = randomUUID()
      const owner = createHash('sha256').update(userId).digest('hex')
      const temporaryKey = `pending/owners/${owner}/${id}`
      await repository.create({
        ...metadata,
        id,
        userId,
        temporaryKey,
        finalKey: null,
        status: 'pending',
        scanVersion: null,
        scannedAt: null,
        rejectionReason: null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        claimToken: null,
        claimExpiresAt: null,
      })
      const signed = await storage.presignPut(temporaryKey, metadata.contentType)
      return {
        id,
        uploadUrl: signed.url,
        headers: signed.headers,
        expiresAt: signed.expiresAt.toISOString(),
      }
    },
    async get(userId: string, id: string) {
      return getView(userId, id)
    },
    async download(userId: string, id: string) {
      const record = await getView(userId, id)
      if (record?.status !== 'clean' || !record.finalKey) return null
      const bytes = await storage.read(record.finalKey, record.contentType)
      if (
        bytes.length !== record.size ||
        createHash('sha256').update(bytes).digest('hex') !== record.sha256
      )
        throw new Error('Invalid attachment content')
      return bytes
    },
    async complete(userId: string, id: string) {
      if (activeCompletions >= 2) throw new Error('Attachment scanning is busy')
      activeCompletions++
      try {
        const existing = await getView(userId, id)
        if (!existing) throw new Error('Attachment not found')
        if (
          existing.status === 'clean' ||
          existing.status === 'rejected' ||
          existing.status === 'expired'
        )
          return existing
        const token = randomUUID()
        const record = await repository.claimCompletion(userId, id, token)
        if (!record) return (await repository.get(userId, id)) ?? existing
        const finalKey = `${record.temporaryKey.replace(/^pending\//, 'objects/')}/${randomUUID()}`
        const finish = async (
          status: 'clean' | 'rejected' | 'error',
          version: string | null,
          scannedAt: Date | null,
          rejectionReason: string | null = null,
        ) =>
          repository.finishCompletion(userId, id, token, {
            status,
            finalKey: status === 'clean' ? finalKey : null,
            scanVersion: version,
            scannedAt,
            rejectionReason,
          })
        try {
          await storage.copy(record.temporaryKey, finalKey, record.size, record.contentType)
          const bytes = await storage.read(finalKey, record.contentType)
          if (
            bytes.length !== record.size ||
            createHash('sha256').update(bytes).digest('hex') !== record.sha256
          ) {
            await storage.delete(finalKey)
            return (
              (await finish('rejected', null, null, 'checksum_mismatch')) ??
              (await repository.get(userId, id)) ??
              record
            )
          }
          try {
            await validateArchives(bytes, record.filename)
          } catch (error) {
            await storage.delete(finalKey)
            return (
              (await finish(
                'rejected',
                null,
                null,
                error instanceof UnsupportedArchiveError ? 'unsupported_archive' : 'unsafe_archive',
              )) ??
              (await repository.get(userId, id)) ??
              record
            )
          }
          const result = await scanner.scan(bytes)
          if (result.result !== 'clean') {
            await storage.delete(finalKey)
            return (
              (await finish('rejected', result.version, new Date(), 'infected')) ??
              (await repository.get(userId, id)) ??
              record
            )
          }
          const saved = await finish('clean', result.version, new Date())
          if (!saved) await storage.delete(finalKey)
          return saved ?? (await repository.get(userId, id)) ?? record
        } catch (error) {
          await storage.delete(finalKey).catch(() => {})
          return (
            (await finish(
              error instanceof AttachmentMismatchError ? 'rejected' : 'error',
              null,
              null,
              error instanceof AttachmentMismatchError ? 'checksum_mismatch' : null,
            )) ??
            (await repository.get(userId, id)) ??
            record
          )
        }
      } finally {
        activeCompletions--
      }
    },
    async resolveReferences(
      userId: string,
      refs: { id: string; contentId?: string | undefined }[],
    ) {
      if (refs.length > 10 || new Set(refs.map((ref) => ref.id)).size !== refs.length)
        throw new Error('Invalid attachment references')
      const cids = refs.flatMap((ref) => (ref.contentId ? [ref.contentId] : []))
      if (new Set(cids).size !== cids.length) throw new Error('Duplicate content ID')
      let total = 0
      return Promise.all(
        refs.map(async (ref) => {
          const record = await repository.get(userId, ref.id)
          if (record?.status !== 'clean' || !record.finalKey)
            throw new Error('Attachment unavailable')
          total += record.size
          if (total > 20_000_000) throw new Error('Attachments too large')
          const bytes = await storage.read(record.finalKey, record.contentType)
          if (
            bytes.length !== record.size ||
            createHash('sha256').update(bytes).digest('hex') !== record.sha256 ||
            (ref.contentId && !validImageContent(record.contentType, bytes))
          )
            throw new Error('Invalid attachment content')
          return {
            filename: record.filename,
            content: bytes.toString('base64'),
            ...(ref.contentId ? { contentId: ref.contentId, contentType: record.contentType } : {}),
          }
        }),
      )
    },
  }
}
export type AttachmentService = ReturnType<typeof createAttachmentService>
