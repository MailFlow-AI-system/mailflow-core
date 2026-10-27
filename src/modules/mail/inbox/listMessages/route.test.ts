import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'

import { createApp } from '../../../../app.js'
import type { AuthService } from '../../../identityWorkspace/infrastructure/types/auth.js'
import type { MailMessageRepository } from './types.js'

function createTestApp(authenticated = true) {
  const repository = { findMessages: vi.fn().mockResolvedValue([]) } satisfies MailMessageRepository
  const auth: AuthService = {
    handler: async () => new Response(),
    api: {
      getSession: async () =>
        authenticated ? { session: { id: 'session' }, user: { id: 'user' } } : null,
    },
  }

  const resolveWorkspace = vi
    .fn()
    .mockResolvedValue({ id: 'workspace-a', name: 'Acme', slug: 'acme', role: 'owner' })
  const consumeBudget = vi.fn().mockResolvedValue(0)
  const app = createApp({
    config: {
      appEnv: 'development',
      databaseUrl: 'postgresql://test:test@localhost:5432/test',
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'silent',
      apiDocsEnabled: true,
      serviceVersion: 'test',
      otlpEndpoint: undefined,
      otelTraceSampleRate: 0.1,
      serviceInstanceId: 'test',
    },
    logger: pino({ enabled: false }),
    checkDatabase: async () => {},
    auth,
    allowedAuthOrigins: ['http://localhost:3000'],
    mailRepository: repository,
    workspaces: {
      reader: {
        list: async () => ({ items: [], nextCursor: null }),
        context: resolveWorkspace,
      },
      consumeBudget,
    },
  })

  return { app, repository, resolveWorkspace, consumeBudget }
}

describe('GET /api/v1/workspaces/acme/mail/messages', () => {
  it('returns authenticated messages and preserves credentialed CORS', async () => {
    const { app, repository } = createTestApp()
    const message = {
      id: '00000000-0000-4000-8000-000000000001',
      senderName: 'Sender',
      subject: 'Subject',
      body: 'Complete body',
      receivedAt: new Date('2026-10-01T12:00:00.000Z'),
    }
    repository.findMessages.mockResolvedValue([message])

    const response = await app.request('/api/v1/workspaces/acme/mail/messages?q=%20invoice%20', {
      headers: { Origin: 'http://localhost:3000' },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
    expect(await response.json()).toEqual({
      items: [{ ...message, receivedAt: message.receivedAt.toISOString() }],
      nextCursor: null,
    })
    expect(repository.findMessages).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      search: 'invoice',
      cursor: null,
    })
  })

  it('rejects unauthenticated requests before querying messages', async () => {
    const { app, repository } = createTestApp(false)

    const response = await app.request('/api/v1/workspaces/acme/mail/messages?cursor=malformed')

    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(await response.json()).toMatchObject({ code: 'authentication_required' })
    expect(repository.findMessages).not.toHaveBeenCalled()
  })

  it.each(['malformed', ''])('returns problem details for invalid cursor %s', async (cursor) => {
    const { app, repository } = createTestApp()

    const response = await app.request(`/api/v1/workspaces/acme/mail/messages?cursor=${cursor}`, {
      headers: { 'x-request-id': 'cursor-test' },
    })

    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(await response.json()).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'The message cursor is invalid.',
      instance: '/api/v1/workspaces/acme/mail/messages',
      code: 'invalid_message_cursor',
      requestId: 'cursor-test',
    })
    expect(repository.findMessages).not.toHaveBeenCalled()
  })

  it('returns a safe problem response when the database fails', async () => {
    const { app, repository } = createTestApp()
    repository.findMessages.mockRejectedValue(new Error('sensitive database credentials'))

    const response = await app.request('/api/v1/workspaces/acme/mail/messages')
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(JSON.parse(body)).toMatchObject({ code: 'internal_error' })
    expect(body).not.toContain('sensitive database credentials')
  })

  it.each(['unknown', 'unrelated'])(
    'returns the same unavailable response for %s membership',
    async (slug) => {
      const { app, repository, resolveWorkspace, consumeBudget } = createTestApp()
      resolveWorkspace.mockResolvedValue(null)
      const response = await app.request(`/api/v1/workspaces/${slug}/mail/messages`)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ code: 'workspace_unavailable' })
      expect(repository.findMessages).not.toHaveBeenCalled()
      expect(consumeBudget).not.toHaveBeenCalled()
    },
  )

  it('accepts the expected identity and returns private workspace-scoped data', async () => {
    const { app, repository } = createTestApp()
    const response = await app.request('/api/v1/workspaces/acme/mail/messages', {
      headers: { 'X-Workspace-Identity': 'user' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('X-Workspace-Identity')).toBe('user')
    expect(repository.findMessages).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      search: '',
      cursor: null,
    })
  })

  it.each(['bad_slug', 'a'.repeat(64)])(
    'rejects invalid selector %s before resolving membership',
    async (slug) => {
      const { app, repository, resolveWorkspace } = createTestApp()
      expect((await app.request(`/api/v1/workspaces/${slug}/mail/messages`)).status).toBe(400)
      expect(resolveWorkspace).not.toHaveBeenCalled()
      expect(repository.findMessages).not.toHaveBeenCalled()
    },
  )

  it('rejects changed identity before resolving membership or querying messages', async () => {
    const { app, repository, resolveWorkspace, consumeBudget } = createTestApp()
    const response = await app.request('/api/v1/workspaces/acme/mail/messages', {
      headers: { 'X-Workspace-Identity': 'other-user' },
    })
    expect(response.status).toBe(403)
    expect(response.headers.get('X-Workspace-Identity')).toBe('user')
    expect(await response.json()).toMatchObject({ code: 'workspace_identity_changed' })
    expect(resolveWorkspace).not.toHaveBeenCalled()
    expect(repository.findMessages).not.toHaveBeenCalled()
    expect(consumeBudget).not.toHaveBeenCalled()
  })

  it('does not consume discovery budget for inbox requests or unknown mail paths', async () => {
    const { app, consumeBudget, resolveWorkspace } = createTestApp()
    expect((await app.request('/api/v1/workspaces/acme/mail/messages')).status).toBe(200)
    expect((await app.request('/api/v1/workspaces/acme/mail/unknown')).status).toBe(404)
    expect(resolveWorkspace).toHaveBeenCalledWith('user', 'acme')
    expect(consumeBudget).not.toHaveBeenCalled()
  })

  it.each(['messages', 'unknown', 'messages/extra'])(
    'authenticates every mail path: %s',
    async (path) => {
      const { app, repository, resolveWorkspace } = createTestApp(false)
      expect((await app.request(`/api/v1/workspaces/acme/mail/${path}`)).status).toBe(401)
      expect(resolveWorkspace).not.toHaveBeenCalled()
      expect(repository.findMessages).not.toHaveBeenCalled()
    },
  )

  it('blocks unknown mail paths on failed membership', async () => {
    const { app, resolveWorkspace, consumeBudget } = createTestApp()
    resolveWorkspace.mockResolvedValue(null)
    const response = await app.request('/api/v1/workspaces/acme/mail/unknown')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'workspace_unavailable' })
    expect(consumeBudget).not.toHaveBeenCalled()
  })

  it('never exposes the old global inbox', async () => {
    const { app } = createTestApp()
    expect((await app.request('/api/v1/mail/messages')).status).toBe(404)
  })

  it('publishes the inbox query and response contract in OpenAPI', async () => {
    const { app } = createTestApp()

    const response = await app.request('/openapi.json')
    const specification = await response.json()
    const operation = specification.paths['/api/v1/workspaces/{slug}/mail/messages'].get

    expect(operation.parameters.map((parameter: { name: string }) => parameter.name)).toEqual([
      'slug',
      'q',
      'cursor',
    ])
    expect(operation.responses).toHaveProperty('200')
    expect(operation.responses).toHaveProperty('400')
    expect(operation.responses).toHaveProperty('401')
    expect(operation.responses).toHaveProperty('500')
  })
})
