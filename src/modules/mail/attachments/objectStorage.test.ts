import { describe, expect, it } from 'vitest'
import { loadStorageConfig } from './objectStorage.js'

describe('object storage configuration', () => {
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
