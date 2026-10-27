import { createHash, randomUUID } from 'node:crypto'
import { assertMailContext, type MailContext } from '../context/types.js'
import { UnsupportedArchiveError, validateArchives } from './archiveValidation.js'
import { finalAttachmentKey, temporaryAttachmentKey } from './attachmentKeys.js'
import { validImageContent } from './imageValidation.js'
import {
  type AttachmentMetadata,
  AttachmentMismatchError,
  type AttachmentRepository,
  type AttachmentView,
  type ObjectStorage,
} from './types.js'

export function createAttachmentService({
  repository,
  storage,
}: {
  repository: AttachmentRepository
  storage: ObjectStorage
}) {
  let activeCompletions = 0
  async function getView(context: MailContext, id: string): Promise<AttachmentView | null> {
    assertMailContext(context)
    const record = await repository.get(context, id)
    if (!record || record.status === 'deleting') return null
    const associated = await repository.isAssociated(context, id)
    return {
      ...record,
      associated,
      status: record.expiresAt.getTime() <= Date.now() && !associated ? 'expired' : record.status,
    }
  }
  return {
    async create(context: MailContext, metadata: AttachmentMetadata) {
      const id = randomUUID()
      assertMailContext(context)
      const temporaryKey = temporaryAttachmentKey(context, id)
      await repository.create({
        ...metadata,
        id,
        ...context,
        temporaryKey,
        finalKey: null,
        status: 'pending',
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
    async get(context: MailContext, id: string) {
      return getView(context, id)
    },
    async download(context: MailContext, id: string) {
      const record = await getView(context, id)
      if (record?.status !== 'clean' || !record.finalKey) return null
      const bytes = await storage.read(record.finalKey, record.contentType)
      if (
        bytes.length !== record.size ||
        createHash('sha256').update(bytes).digest('hex') !== record.sha256
      )
        throw new Error('Invalid attachment content')
      return bytes
    },
    async complete(context: MailContext, id: string) {
      if (activeCompletions >= 2) throw new Error('Attachment verification is busy')
      activeCompletions++
      try {
        const existing = await getView(context, id)
        if (!existing) throw new Error('Attachment not found')
        if (
          existing.status === 'clean' ||
          existing.status === 'rejected' ||
          existing.status === 'expired'
        )
          return existing
        const token = randomUUID()
        const record = await repository.claimCompletion(context, id, token)
        if (!record) return (await repository.get(context, id)) ?? existing
        const finalKey = finalAttachmentKey(context, id, randomUUID())
        const finish = async (
          status: 'clean' | 'rejected' | 'error',
          rejectionReason: string | null = null,
        ) =>
          repository.finishCompletion(context, id, token, {
            status,
            finalKey: status === 'clean' ? finalKey : null,
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
              (await finish('rejected', 'checksum_mismatch')) ??
              (await repository.get(context, id)) ??
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
                error instanceof UnsupportedArchiveError ? 'unsupported_archive' : 'unsafe_archive',
              )) ??
              (await repository.get(context, id)) ??
              record
            )
          }
          const saved = await finish('clean')
          if (!saved) await storage.delete(finalKey)
          return saved ?? (await repository.get(context, id)) ?? record
        } catch (error) {
          await storage.delete(finalKey).catch(() => {})
          return (
            (await finish(
              error instanceof AttachmentMismatchError ? 'rejected' : 'error',
              error instanceof AttachmentMismatchError ? 'checksum_mismatch' : null,
            )) ??
            (await repository.get(context, id)) ??
            record
          )
        }
      } finally {
        activeCompletions--
      }
    },
    async resolveReferences(
      context: MailContext,
      refs: { id: string; contentId?: string | undefined }[],
    ) {
      assertMailContext(context)
      if (refs.length > 10 || new Set(refs.map((ref) => ref.id)).size !== refs.length)
        throw new Error('Invalid attachment references')
      const cids = refs.flatMap((ref) => (ref.contentId ? [ref.contentId] : []))
      if (new Set(cids).size !== cids.length) throw new Error('Duplicate content ID')
      let total = 0
      return Promise.all(
        refs.map(async (ref) => {
          const record = await repository.get(context, ref.id)
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
