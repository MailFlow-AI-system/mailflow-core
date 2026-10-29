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
    workspaceId: 'workspace-a',
    filename: 'a.txt',
    contentType: 'text/plain',
    size: 1,
    sha256: 'a'.repeat(64),
    status: 'clean' as const,
    temporaryKey: 'secret-temporary-key',
    finalKey: 'secret-final-key',
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
    context.set('mailContext', { workspaceId: 'workspace-a', userId: 'owner' })
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
    context.set('mailContext', { workspaceId: 'workspace-a', userId: 'owner' })
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
    workspaceId: 'workspace-a',
    filename: 'a.txt',
    contentType: 'text/plain',
    size: 0,
    sha256: 'a'.repeat(64),
    status: 'expired' as const,
    temporaryKey: 'private',
    finalKey: null,
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
    context.set('mailContext', { workspaceId: 'workspace-a', userId: 'owner' })
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

it('serves only verified safe image bytes inline and preserves download filenames', async () => {
  const { OpenAPIHono } = await import('@hono/zod-openapi')
  const id = '00000000-0000-4000-8000-000000000001'
  const image = Buffer.from('89504e470d0a1a0a', 'hex')
  const record = { id, filename: 'hello.png', contentType: 'image/png', status: 'clean' as const }
  const service = {
    create: vi.fn(),
    complete: vi.fn(),
    get: vi.fn(async () => record as never),
    download: vi.fn(async () => image),
    resolveReferences: vi.fn(),
  }
  const app = new OpenAPIHono()
  app.use('*', async (context, next) => {
    context.set('mailContext', { userId: 'owner', workspaceId: 'workspace-a' })
    await next()
  })
  app.route(
    '/',
    createAttachmentModule(service, () => true),
  )
  const inline = await app.request(`/api/v1/mail/attachments/${id}/inline`)
  expect(inline.status).toBe(200)
  expect(inline.headers.get('content-type')).toBe('image/png')
  expect(inline.headers.get('cache-control')).toBe('private, no-store')
  const download = await app.request(`/api/v1/mail/attachments/${id}/download`)
  expect(download.headers.get('content-disposition')).toContain('hello.png')
  service.get.mockResolvedValue({ ...record, contentType: 'image/svg+xml' } as never)
  expect((await app.request(`/api/v1/mail/attachments/${id}/inline`)).status).toBe(404)
})
