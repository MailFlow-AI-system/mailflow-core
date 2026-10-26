export class AttachmentQuotaError extends Error {}
export class AttachmentMismatchError extends Error {}

/** The legacy "clean" state identifies verified immutable content. */
export type AttachmentStatus = 'pending' | 'clean' | 'rejected' | 'error' | 'deleting'
export type AttachmentMetadata = {
  filename: string
  contentType: string
  size: number
  sha256: string
}
export type AttachmentRecord = AttachmentMetadata & {
  id: string
  userId: string
  status: AttachmentStatus
  temporaryKey: string
  finalKey: string | null
  rejectionReason: string | null
  expiresAt: Date
  claimToken: string | null
  claimExpiresAt: Date | null
}
export type AttachmentView = Omit<AttachmentRecord, 'status'> & {
  status: Exclude<AttachmentStatus, 'deleting'> | 'expired'
  associated: boolean
}
export type AttachmentRepository = {
  create: (record: AttachmentRecord) => Promise<AttachmentRecord>
  get: (userId: string, id: string) => Promise<AttachmentRecord | null>
  isAssociated: (userId: string, id: string) => Promise<boolean>
  isFinalKeyReferenced: (key: string) => Promise<boolean>
  claimExpired: (limit: number, token: string) => Promise<AttachmentRecord[]>
  deleteClaimed: (userId: string, id: string, token: string) => Promise<boolean>
  claimCompletion: (userId: string, id: string, token: string) => Promise<AttachmentRecord | null>
  finishCompletion: (
    userId: string,
    id: string,
    token: string,
    patch: Pick<AttachmentRecord, 'status' | 'finalKey' | 'rejectionReason'>,
  ) => Promise<AttachmentRecord | null>
}
export type ObjectStorage = {
  listOldFinalKeys: (cursor?: string) => Promise<{ keys: string[]; nextCursor?: string }>
  presignPut: (
    key: string,
    contentType: string,
  ) => Promise<{ url: string; headers: Record<string, string>; expiresAt: Date }>
  copy: (
    source: string,
    destination: string,
    expectedSize: number,
    expectedContentType: string,
  ) => Promise<void>
  read: (key: string, expectedContentType?: string) => Promise<Buffer>
  delete: (key: string) => Promise<void>
}
