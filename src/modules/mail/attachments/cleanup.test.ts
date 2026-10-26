import { describe, expect, it, vi } from 'vitest'
import { cleanupAttachments } from './cleanup.js'

describe('attachment cleanup', () => {
  it('preserves all blobs when a claimed attachment is associated with an outgoing message', async () => {
    const repository = {
      claimExpired: vi.fn(async () => [
        {
          id: 'id',
          userId: 'owner',
          temporaryKey: 'pending',
          finalKey: 'final',
          status: 'deleting' as const,
          filename: 'a',
          contentType: 'text/plain',
          size: 1,
          sha256: 'a'.repeat(64),
          scanVersion: 'test',
          scannedAt: new Date(),
          rejectionReason: null,
          expiresAt: new Date(),
          claimToken: null,
          claimExpiresAt: null,
        },
      ]),
      isAssociated: vi.fn(async () => true),
      deleteClaimed: vi.fn(async () => true),
    }
    const storage = { delete: vi.fn(async () => {}) }
    expect(await cleanupAttachments(repository, storage)).toBe(0)
    expect(repository.isAssociated).toHaveBeenCalledWith('owner', 'id')
    expect(storage.delete).not.toHaveBeenCalled()
    expect(repository.deleteClaimed).not.toHaveBeenCalled()
  })

  it('keeps the claim for retry if object deletion fails', async () => {
    const repository = {
      claimExpired: vi.fn(async () => [
        {
          id: 'id',
          userId: 'owner',
          temporaryKey: 'pending',
          finalKey: 'final',
          status: 'deleting' as const,
          filename: 'a',
          contentType: 'text/plain',
          size: 1,
          sha256: 'a'.repeat(64),
          scanVersion: null,
          scannedAt: null,
          rejectionReason: null,
          expiresAt: new Date(),
          claimToken: null,
          claimExpiresAt: null,
        },
      ]),
      isAssociated: vi.fn(async () => false),
      deleteClaimed: vi.fn(async () => true),
    }
    const storage = { delete: vi.fn().mockRejectedValueOnce(new Error('storage unavailable')) }
    expect(await cleanupAttachments(repository, storage)).toBe(0)
    expect(repository.deleteClaimed).not.toHaveBeenCalled()
  })
})

it('removes only old unreferenced final objects', async () => {
  const repository = { isFinalKeyReferenced: vi.fn(async (key: string) => key === 'retained') }
  const storage = {
    listOldFinalKeys: vi.fn(async () => ({ keys: ['retained', 'orphan'] })),
    delete: vi.fn(async () => {}),
  }
  const { cleanupOrphanObjects } = await import('./cleanup.js')
  const result = await cleanupOrphanObjects(repository, storage)
  expect(storage.delete).toHaveBeenCalledWith('orphan')
  expect(storage.delete).not.toHaveBeenCalledWith('retained')
  expect(result.deleted).toBe(1)
})
