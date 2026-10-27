import { describe, expect, it, vi } from 'vitest'
import { cleanupAttachments } from './cleanup.js'

describe('attachment cleanup', () => {
  it('preserves all blobs when a claimed attachment is associated with an outgoing message', async () => {
    const repository = {
      claimExpired: vi.fn(async () => [
        {
          id: 'id',
          userId: 'owner',
          workspaceId: 'workspace-a',
          temporaryKey: 'pending',
          finalKey: 'final',
          status: 'deleting' as const,
          filename: 'a',
          contentType: 'text/plain',
          size: 1,
          sha256: 'a'.repeat(64),
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
    expect(repository.isAssociated).toHaveBeenCalledWith(
      { workspaceId: 'workspace-a', userId: 'owner' },
      'id',
    )
    expect(storage.delete).not.toHaveBeenCalled()
    expect(repository.deleteClaimed).not.toHaveBeenCalled()
  })

  it('keeps the claim for retry if object deletion fails', async () => {
    const repository = {
      claimExpired: vi.fn(async () => [
        {
          id: 'id',
          userId: 'owner',
          workspaceId: 'workspace-a',
          temporaryKey: 'pending',
          finalKey: 'final',
          status: 'deleting' as const,
          filename: 'a',
          contentType: 'text/plain',
          size: 1,
          sha256: 'a'.repeat(64),
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
  const prefix = 'workspaces/workspace-a/mail/attachments/00000000-0000-4000-8000-000000000001/'
  const retained = `${prefix}00000000-0000-4000-8000-000000000002`
  const orphan = `${prefix}00000000-0000-4000-8000-000000000003`
  const repository = { isFinalKeyReferenced: vi.fn(async (key: string) => key === retained) }
  const storage = {
    listOldFinalKeys: vi.fn(async () => ({
      keys: [
        retained,
        orphan,
        'workspaces/workspace-a/avatars/photo.png',
        'objects/unrelated-asset',
      ],
    })),
    delete: vi.fn(async () => {}),
  }
  const { cleanupOrphanObjects } = await import('./cleanup.js')
  const result = await cleanupOrphanObjects(repository, storage)
  expect(storage.delete).toHaveBeenCalledWith(orphan)
  expect(storage.delete).toHaveBeenCalledTimes(1)
  expect(repository.isFinalKeyReferenced).toHaveBeenCalledWith(orphan, 'workspace-a')
  expect(result.deleted).toBe(1)
})

it('protects referenced legacy Mail keys without guessing a workspace', async () => {
  const legacy = `objects/owners/${'a'.repeat(64)}/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002`
  const repository = { isFinalKeyReferenced: vi.fn(async () => true) }
  const storage = {
    listOldFinalKeys: vi.fn(async () => ({ keys: [legacy] })),
    delete: vi.fn(async () => {}),
  }
  const { cleanupOrphanObjects } = await import('./cleanup.js')
  expect((await cleanupOrphanObjects(repository, storage)).deleted).toBe(0)
  expect(repository.isFinalKeyReferenced).toHaveBeenCalledWith(legacy, undefined)
  expect(storage.delete).not.toHaveBeenCalled()
})
