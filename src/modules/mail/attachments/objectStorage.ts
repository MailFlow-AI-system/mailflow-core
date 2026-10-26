import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { z } from 'zod'
import { AttachmentMismatchError, type ObjectStorage } from './types.js'

export function loadStorageConfig(environment: Record<string, string | undefined>) {
  const config = z
    .object({
      R2_ACCOUNT_ID: z.string().min(1),
      R2_BUCKET_NAME: z.string().min(1),
      R2_ACCESS_KEY_ID: z.string().min(1),
      R2_SECRET_ACCESS_KEY: z.string().min(1),
      R2_ENDPOINT: z.url().optional(),
    })
    .parse(environment)
  const endpoint = config.R2_ENDPOINT ?? `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  const url = new URL(endpoint)
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      environment.APP_ENV === 'development' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
  )
    throw new Error('Object storage endpoint must use HTTPS')
  return {
    endpoint,
    bucket: config.R2_BUCKET_NAME,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    },
  }
}
export function createObjectStorage(
  environment: Record<string, string | undefined>,
): ObjectStorage {
  const config = loadStorageConfig(environment)
  const client = new S3Client({
    endpoint: config.endpoint,
    region: 'auto',
    credentials: config.credentials,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5_000,
      requestTimeout: 30_000,
      socketTimeout: 15_000,
      throwOnRequestTimeout: true,
    }),
  })
  const expiresIn = 300
  return {
    async listOldFinalKeys(cursor) {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: 'objects/',
          MaxKeys: 1000,
          ContinuationToken: cursor,
        }),
      )
      const cutoff = Date.now() - 24 * 60 * 60 * 1000
      return {
        keys: (page.Contents ?? [])
          .filter((item) => item.Key && item.LastModified && item.LastModified.getTime() < cutoff)
          .map((item) => item.Key as string),
        ...(page.NextContinuationToken ? { nextCursor: page.NextContinuationToken } : {}),
      }
    },
    async presignPut(key, contentType) {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: contentType }),
        { expiresIn, signableHeaders: new Set(['content-type']) },
      )
      return {
        url,
        headers: { 'Content-Type': contentType },
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      }
    },
    async copy(source, destination, expectedSize, expectedContentType) {
      const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: source }))
      if (
        head.ContentLength !== expectedSize ||
        head.ContentType !== expectedContentType ||
        !head.ETag
      )
        throw new AttachmentMismatchError('Invalid uploaded object')
      await client.send(
        new CopyObjectCommand({
          Bucket: config.bucket,
          Key: destination,
          CopySourceIfMatch: head.ETag,
          CopySource: `/${config.bucket}/${source.split('/').map(encodeURIComponent).join('/')}`,
        }),
      )
    },
    async read(key, expectedContentType) {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
      if (
        !result.Body ||
        (expectedContentType && result.ContentType !== expectedContentType) ||
        (result.ContentLength ?? Infinity) > 10_000_000
      ) {
        if (result.Body && 'destroy' in result.Body && typeof result.Body.destroy === 'function')
          result.Body.destroy()
        throw new Error('Invalid stored attachment')
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length
        if (size > 10_000_000) throw new Error('Stored attachment is too large')
        chunks.push(Buffer.from(chunk))
      }
      return Buffer.concat(chunks)
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
    },
  }
}
