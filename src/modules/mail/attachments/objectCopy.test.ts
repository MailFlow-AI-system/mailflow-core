import { beforeEach, expect, it, vi } from 'vitest'

const send = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const original = await importOriginal<typeof import('@aws-sdk/client-s3')>()
  return {
    ...original,
    S3Client: class {
      send = send
    },
  }
})
const env = {
  R2_ACCOUNT_ID: 'test',
  R2_BUCKET_NAME: 'test',
  R2_ACCESS_KEY_ID: 'test',
  R2_SECRET_ACCESS_KEY: 'test',
}
beforeEach(() => send.mockReset())
it('does not copy an oversized upload and pins the verified source ETag', async () => {
  const { createObjectStorage } = await import('./objectStorage.js')
  const storage = createObjectStorage(env)
  send.mockResolvedValueOnce({ ContentLength: 100, ContentType: 'text/plain', ETag: 'etag' })
  await expect(storage.copy('pending/key', 'objects/key', 5, 'text/plain')).rejects.toThrow()
  expect(send).toHaveBeenCalledTimes(1)
  send.mockReset()
  send
    .mockResolvedValueOnce({ ContentLength: 5, ContentType: 'text/plain', ETag: 'etag' })
    .mockResolvedValueOnce({})
  await storage.copy('pending/key', 'objects/key', 5, 'text/plain')
  expect(send.mock.calls[1]?.[0].input.CopySourceIfMatch).toBe('etag')
})

it('accepts an empty uploaded object', async () => {
  const { createObjectStorage } = await import('./objectStorage.js')
  const storage = createObjectStorage(env)
  send
    .mockResolvedValueOnce({ ContentLength: 0, ContentType: 'text/plain', ETag: 'empty-etag' })
    .mockResolvedValueOnce({})
  await expect(
    storage.copy('pending/empty', 'objects/empty', 0, 'text/plain'),
  ).resolves.toBeUndefined()
  expect(send.mock.calls[1]?.[0].input.CopySourceIfMatch).toBe('empty-etag')
})
