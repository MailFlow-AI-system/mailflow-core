import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { resolveCapabilities } from '#modules/identityWorkspace'

import { createApp } from '../../../../app.js'
import type { MailMessageRepository, MessageStateView } from '../listMessages/types.js'

const origin = 'http://localhost:3000'
const id = '00000000-0000-4000-8000-000000000001'
const otherId = '00000000-0000-4000-8000-000000000002'
const base = '/api/v1/workspaces/acme/mail'
const state: MessageStateView = {
  id,
  isRead: true,
  isStarred: false,
  folder: 'archive',
  archivedAt: '2026-10-01T12:00:00.000Z',
  archivedBy: 'user',
  trashedAt: null,
  trashedBy: null,
  spamAt: null,
  spamBy: null,
}

function createTestApp(role: 'owner' | 'viewer' = 'owner') {
  const repository = {
    findMessages: vi.fn().mockResolvedValue([]),
    findMessage: vi.fn().mockResolvedValue(null),
    countUnread: vi.fn().mockResolvedValue({ inbox: 3, starred: 1, archive: 0, trash: 2, spam: 4 }),
    updateMessage: vi.fn().mockResolvedValue(state),
    applyAction: vi.fn().mockResolvedValue([{ id, status: 'ok' }]),
  } satisfies MailMessageRepository
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
    auth: {
      handler: async () => new Response(),
      api: { getSession: async () => ({ session: { id: 'session' }, user: { id: 'user' } }) },
    },
    allowedAuthOrigins: [origin],
    mailRepository: repository,
    workspaces: {
      reader: {
        list: async () => ({ items: [], nextCursor: null }),
        context: async () => ({
          id: 'workspace-a',
          name: 'Acme',
          slug: 'acme',
          role,
          capabilities: resolveCapabilities(role),
        }),
      },
      consumeBudget: vi.fn(),
    },
  })
  return { app, repository }
}

const json = (
  method: string,
  body: unknown,
  headers: Record<string, string> = { Origin: origin },
) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

describe('folder query', () => {
  it('passes the folder to the repository for the current user', async () => {
    const { app, repository } = createTestApp()
    const response = await app.request(`${base}/messages?folder=spam&q=invoice`)
    expect(response.status).toBe(200)
    expect(repository.findMessages).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      userId: 'user',
      folder: 'spam',
      search: 'invoice',
      cursor: null,
    })
  })

  it.each(['unknown', 'INBOX', '', 'drafts'])(
    'rejects folder %j with problem details',
    async (folder) => {
      const { app, repository } = createTestApp()
      const response = await app.request(`${base}/messages?folder=${folder}`)
      expect(response.status).toBe(400)
      expect(response.headers.get('content-type')).toContain('application/problem+json')
      expect(await response.json()).toMatchObject({ code: 'invalid_message_query', status: 400 })
      expect(repository.findMessages).not.toHaveBeenCalled()
    },
  )
})

describe('GET unread counts', () => {
  it('returns the current user counts for every folder', async () => {
    const { app, repository } = createTestApp('viewer')
    const response = await app.request(`${base}/unread-counts`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ inbox: 3, starred: 1, archive: 0, trash: 2, spam: 4 })
    expect(repository.countUnread).toHaveBeenCalledWith('workspace-a', 'user')
  })
})

describe('PATCH message', () => {
  it('applies a partial change and returns the updated state', async () => {
    const { app, repository } = createTestApp()
    const response = await app.request(
      `${base}/messages/${id}`,
      json('PATCH', { archived: true, read: true }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(state)
    expect(repository.updateMessage).toHaveBeenCalledWith('workspace-a', 'user', id, {
      archived: true,
      read: true,
    })
  })

  it('lets a read-only member change their own read and star state', async () => {
    const { app, repository } = createTestApp('viewer')
    const response = await app.request(
      `${base}/messages/${id}`,
      json('PATCH', { read: false, starred: true }),
    )
    expect(response.status).toBe(200)
    expect(repository.updateMessage).toHaveBeenCalled()
  })

  it.each([{ archived: true }, { trashed: false }, { spam: true, read: true }])(
    'requires mail.compose for workspace state %j',
    async (body) => {
      const { app, repository } = createTestApp('viewer')
      const response = await app.request(`${base}/messages/${id}`, json('PATCH', body))
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'insufficient_capability' })
      expect(repository.updateMessage).not.toHaveBeenCalled()
    },
  )

  it.each([{}, { read: 'yes' }, { pinned: true }])('rejects invalid body %j', async (body) => {
    const { app, repository } = createTestApp()
    const response = await app.request(`${base}/messages/${id}`, json('PATCH', body))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid_message_action' })
    expect(repository.updateMessage).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON', async () => {
    const { app } = createTestApp()
    const response = await app.request(`${base}/messages/${id}`, {
      method: 'PATCH',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{',
    })
    expect(response.status).toBe(400)
  })

  it('requires a trusted Origin', async () => {
    const { app, repository } = createTestApp()
    for (const headers of [{}, { Origin: 'https://evil.example' }]) {
      const response = await app.request(
        `${base}/messages/${id}`,
        json('PATCH', { read: true }, headers),
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'untrusted_origin' })
    }
    expect(repository.updateMessage).not.toHaveBeenCalled()
  })

  it('returns 404 for invalid or unavailable messages', async () => {
    const { app, repository } = createTestApp()
    expect(
      (await app.request(`${base}/messages/invalid`, json('PATCH', { read: true }))).status,
    ).toBe(404)
    expect(repository.updateMessage).not.toHaveBeenCalled()
    repository.updateMessage.mockResolvedValue(null)
    const response = await app.request(`${base}/messages/${id}`, json('PATCH', { read: true }))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'message_not_found' })
  })
})

describe('POST bulk message actions', () => {
  it('returns per-item results for deduplicated ids', async () => {
    const { app, repository } = createTestApp()
    repository.applyAction.mockResolvedValue([
      { id, status: 'ok' },
      { id: otherId, status: 'not_found' },
    ])
    const response = await app.request(
      `${base}/messages/actions`,
      json('POST', { ids: [id, otherId, id], action: 'trash' }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      results: [
        { id, status: 'ok' },
        { id: otherId, status: 'not_found' },
      ],
    })
    expect(repository.applyAction).toHaveBeenCalledWith(
      'workspace-a',
      'user',
      [id, otherId],
      'trash',
    )
  })

  it.each(['read', 'unread', 'star', 'unstar'])('lets a read-only member %s', async (action) => {
    const { app } = createTestApp('viewer')
    const response = await app.request(
      `${base}/messages/actions`,
      json('POST', { ids: [id], action }),
    )
    expect(response.status).toBe(200)
  })

  it.each(['archive', 'unarchive', 'trash', 'restore', 'spam', 'not_spam', 'delete_permanently'])(
    'requires mail.compose to %s',
    async (action) => {
      const { app, repository } = createTestApp('viewer')
      const response = await app.request(
        `${base}/messages/actions`,
        json('POST', { ids: [id], action }),
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'insufficient_capability' })
      expect(repository.applyAction).not.toHaveBeenCalled()
    },
  )

  it.each([
    { ids: [], action: 'read' },
    { ids: Array.from({ length: 101 }, () => id), action: 'read' },
    { ids: ['nope'], action: 'read' },
    { ids: [id], action: 'move' },
  ])('rejects invalid body %#', async (body) => {
    const { app, repository } = createTestApp()
    const response = await app.request(`${base}/messages/actions`, json('POST', body))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid_message_action' })
    expect(repository.applyAction).not.toHaveBeenCalled()
  })

  it('requires a trusted Origin', async () => {
    const { app } = createTestApp()
    const response = await app.request(
      `${base}/messages/actions`,
      json('POST', { ids: [id], action: 'read' }, {}),
    )
    expect(response.status).toBe(403)
  })
})

describe('DELETE message permanently', () => {
  const remove = (headers: Record<string, string> = { Origin: origin }) => ({
    method: 'DELETE',
    headers,
  })

  it('deletes a message in Trash with 204', async () => {
    const { app, repository } = createTestApp()
    const response = await app.request(`${base}/messages/${id}`, remove())
    expect(response.status).toBe(204)
    expect(repository.applyAction).toHaveBeenCalledWith(
      'workspace-a',
      'user',
      [id],
      'delete_permanently',
    )
  })

  it('rejects messages outside Trash with 409', async () => {
    const { app, repository } = createTestApp()
    repository.applyAction.mockResolvedValue([{ id, status: 'invalid_state' }])
    const response = await app.request(`${base}/messages/${id}`, remove())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'message_not_in_trash' })
  })

  it('returns 404 for invalid or unavailable messages', async () => {
    const { app, repository } = createTestApp()
    expect((await app.request(`${base}/messages/invalid`, remove())).status).toBe(404)
    repository.applyAction.mockResolvedValue([{ id, status: 'not_found' }])
    expect((await app.request(`${base}/messages/${id}`, remove())).status).toBe(404)
  })

  it('requires mail.compose and a trusted Origin', async () => {
    expect(
      (await createTestApp('viewer').app.request(`${base}/messages/${id}`, remove())).status,
    ).toBe(403)
    const { app, repository } = createTestApp()
    expect((await app.request(`${base}/messages/${id}`, remove({}))).status).toBe(403)
    expect(repository.applyAction).not.toHaveBeenCalled()
  })
})
