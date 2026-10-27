import { S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'
import { loadStorageConfig } from './objectStorage.js'

describe('object storage configuration', () => {
  it('paginates scoped objects before the exact legacy Mail prefix', async () => {
    const request = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({ Contents: [] } as never)
    try {
      const { createObjectStorage } = await import('./objectStorage.js')
      const storage = createObjectStorage({
        R2_ACCOUNT_ID: 'test',
        R2_BUCKET_NAME: 'test',
        R2_ACCESS_KEY_ID: 'test',
        R2_SECRET_ACCESS_KEY: 'test',
      })
      const first = await storage.listOldFinalKeys()
      expect(request.mock.calls[0]?.[0].input).toMatchObject({ Prefix: 'workspaces/' })
      const second = await storage.listOldFinalKeys(first.nextCursor)
      expect(request.mock.calls[1]?.[0].input).toMatchObject({ Prefix: 'objects/owners/' })
      expect(second.nextCursor).toBeUndefined()
    } finally {
      request.mockRestore()
    }
  })
  it('requires all credentials and derives the private R2 endpoint', () => {
    const environment = {
      R2_ACCOUNT_ID: 'account',
      R2_BUCKET_NAME: 'bucket',
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
    }
    expect(loadStorageConfig(environment).endpoint).toBe('https://account.r2.cloudflarestorage.com')
    expect(() => loadStorageConfig({ ...environment, R2_SECRET_ACCESS_KEY: '' })).toThrow()
  })
})

it('does not sign an empty-body checksum for browser uploads', async () => {
  const { createObjectStorage } = await import('./objectStorage.js')
  const storage = createObjectStorage({
    R2_ACCOUNT_ID: 'test',
    R2_BUCKET_NAME: 'test',
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test',
  })
  const signed = await storage.presignPut('pending/owners/test/file', 'text/plain')
  const query = new URL(signed.url).searchParams
  expect(query.has('x-amz-checksum-crc32')).toBe(false)
})

it('refuses insecure endpoints outside local development', () => {
  const environment = {
    R2_ACCOUNT_ID: 'test',
    R2_BUCKET_NAME: 'test',
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test',
  }
  expect(() =>
    loadStorageConfig({
      ...environment,
      APP_ENV: 'production',
      R2_ENDPOINT: 'http://example.test:9000',
    }),
  ).toThrow()
  expect(
    loadStorageConfig({
      ...environment,
      APP_ENV: 'development',
      R2_ENDPOINT: 'http://127.0.0.1:9000',
    }).endpoint,
  ).toBe('http://127.0.0.1:9000')
})

it('signs the declared content type', async () => {
  const { createObjectStorage } = await import('./objectStorage.js')
  const storage = createObjectStorage({
    R2_ACCOUNT_ID: 'test',
    R2_BUCKET_NAME: 'test',
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test',
  })
  const signed = await storage.presignPut('pending/owners/test/file', 'text/plain')
  expect(new URL(signed.url).searchParams.get('X-Amz-SignedHeaders')).toContain('content-type')
})
