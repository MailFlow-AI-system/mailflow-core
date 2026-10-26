import { describe, expect, it, vi } from 'vitest'
import { createAttachmentModule } from './route.js'

describe('attachment HTTP', () => {
  it('requires trusted origin for writes', async () => {
    const service = {
      create: vi.fn(),
      complete: vi.fn(),
      get: vi.fn(),
      download: vi.fn(),
      resolveReferences: vi.fn(),
    }
    const app = createAttachmentModule(service, () => false)
    const response = await app.request('/api/v1/mail/attachments', {
      method: 'POST',
      headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(403)
    expect(service.create).not.toHaveBeenCalled()
  })
})

it('returns only public metadata and hides object keys', async () => {
  const { OpenAPIHono } = await import('@hono/zod-openapi')
  const record = {
    id: '00000000-0000-4000-8000-000000000001',
    userId: 'owner',
    filename: 'a.txt',
    contentType: 'text/plain',
    size: 1,
    sha256: 'a'.repeat(64),
    status: 'clean' as const,
    temporaryKey: 'secret-temporary-key',
    finalKey: 'secret-final-key',
    scanVersion: 'v',
    scannedAt: new Date(),
    rejectionReason: null,
    expiresAt: new Date(),
    associated: false,
    claimToken: null,
    claimExpiresAt: null,
  }
  const service = {
    create: vi.fn(),
    complete: vi.fn(),
    get: vi.fn(async () => record),
    download: vi.fn(),
    resolveReferences: vi.fn(),
  }
  const app = new OpenAPIHono()
  app.use('*', async (context, next) => {
    context.set('authSession', { user: { id: 'owner' }, session: { id: 'session' } })
    await next()
  })
  app.route(
    '/',
    createAttachmentModule(service, () => true),
  )
  const response = await app.request(`/api/v1/mail/attachments/${record.id}`)
  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body).not.toContain('secret-')
  expect(JSON.parse(body)).toMatchObject({ id: record.id, status: 'clean' })
})

it('limits upload initialization request size before parsing', async () => {
  const service = {
    create: vi.fn(),
    complete: vi.fn(),
    get: vi.fn(),
    download: vi.fn(),
    resolveReferences: vi.fn(),
  }
  const app = createAttachmentModule(service, () => true)
  const response = await app.request('/api/v1/mail/attachments', {
    method: 'POST',
    headers: { origin: 'https://mail.test', 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'x'.repeat(10000) }),
  })
  expect(response.status).toBe(413)
  expect(service.create).not.toHaveBeenCalled()
})

it('returns a safe quota error without exposing internal details', async () => {
  const { OpenAPIHono } = await import('@hono/zod-openapi')
  const { AttachmentQuotaError } = await import('./types.js')
  const service = {
    create: vi.fn(async () => {
      throw new AttachmentQuotaError('internal')
    }),
    complete: vi.fn(),
    get: vi.fn(),
    download: vi.fn(),
    resolveReferences: vi.fn(),
  }
  const app = new OpenAPIHono()
  app.use('*', async (context, next) => {
    context.set('authSession', { user: { id: 'owner' }, session: { id: 'session' } })
    await next()
  })
  app.route(
    '/',
    createAttachmentModule(service, () => true),
  )
  const response = await app.request('/api/v1/mail/attachments', {
    method: 'POST',
    headers: { origin: 'https://mail.test', 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: 'a.txt',
      contentType: 'text/plain',
      size: 1,
      sha256: 'a'.repeat(64),
    }),
  })
  expect(response.status).toBe(429)
  expect(await response.text()).not.toContain('internal')
})

it('exposes expired upload state and attachment TTL for recovery', async () => {
  const { OpenAPIHono } = await import('@hono/zod-openapi')
  const record = {
    id: '00000000-0000-4000-8000-000000000001',
    userId: 'owner',
    filename: 'a.txt',
    contentType: 'text/plain',
    size: 0,
    sha256: 'a'.repeat(64),
    status: 'expired' as const,
    temporaryKey: 'private',
    finalKey: null,
    scanVersion: null,
    scannedAt: null,
    rejectionReason: null,
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    associated: false,
    claimToken: null,
    claimExpiresAt: null,
  }
  const service = {
    create: vi.fn(),
    complete: vi.fn(),
    get: vi.fn(async () => record),
    download: vi.fn(),
    resolveReferences: vi.fn(),
  }
  const app = new OpenAPIHono()
  app.use('*', async (context, next) => {
    context.set('authSession', { user: { id: 'owner' }, session: { id: 'session' } })
    await next()
  })
  app.route(
    '/',
    createAttachmentModule(service, () => true),
  )
  const response = await app.request(`/api/v1/mail/attachments/${record.id}`)
  expect(await response.json()).toMatchObject({
    id: record.id,
    status: 'expired',
    associated: false,
    attachmentExpiresAt: '2030-01-01T00:00:00.000Z',
    size: 0,
  })
})
