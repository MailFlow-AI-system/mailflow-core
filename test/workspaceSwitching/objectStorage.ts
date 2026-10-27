import { randomUUID } from 'node:crypto'
import type { ObjectStorage } from '../../src/modules/mail/attachments/types.js'

export function createFixtureObjectStorage(origin: string) {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>()
  const grants = new Map<string, { key: string; contentType: string; expires: number }>()
  const storage: ObjectStorage = {
    async presignPut(key, contentType) {
      const token = randomUUID()
      const expiresAt = new Date(Date.now() + 60_000)
      grants.set(token, { key, contentType, expires: expiresAt.getTime() })
      return {
        url: `${origin}/__fixture/uploads/${token}`,
        headers: { 'Content-Type': contentType },
        expiresAt,
      }
    },
    async read(key, contentType) {
      const object = objects.get(key)
      if (!object || (contentType && object.contentType !== contentType))
        throw new Error('Invalid fixture object metadata')
      return Buffer.from(object.bytes)
    },
    async copy(source, destination, size, contentType) {
      const bytes = await storage.read(source, contentType)
      if (bytes.length !== size) throw new Error('Invalid fixture object size')
      objects.set(destination, { bytes, contentType })
    },
    async delete(key) {
      objects.delete(key)
    },
    async listOldFinalKeys() {
      return { keys: [] }
    },
  }
  return {
    storage,
    async upload(request: Request) {
      const token = new URL(request.url).pathname.split('/').at(-1) ?? ''
      const grant = grants.get(token)
      if (
        !grant ||
        grant.expires <= Date.now() ||
        request.method !== 'PUT' ||
        request.headers.get('content-type') !== grant.contentType
      )
        return new Response(null, { status: 403 })
      grants.delete(token)
      const bytes = Buffer.from(await request.arrayBuffer())
      if (bytes.length > 10_000_000) return new Response(null, { status: 413 })
      objects.set(grant.key, { bytes, contentType: grant.contentType })
      return new Response(null, { status: 204 })
    },
  }
}
