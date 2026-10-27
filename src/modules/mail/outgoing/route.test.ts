import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { MailWorkspaceAuthority } from '#modules/identityWorkspace'
import { createApp } from '../../../app.js'

const input = {
  id: '00000000-0000-4000-8000-000000000001',
  to: ['ada@example.test'],
  cc: [],
  bcc: [],
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [],
}
function setup(authenticated = true, workspace = false) {
  const outgoingMail = {
    repository: {
      reserve: vi.fn(async (value) => ({ ...value, providerId: null, createdAt: new Date() })),
      beginAttempt: vi.fn(async () => ({ token: 'attempt-token', canReject: true })),
      markRejected: vi.fn(async () => {}),
      cleanupAbandoned: vi.fn(async () => 0),
      discard: vi.fn(async () => ({
        status: 'discarded' as const,
        retainedMessageIds: [] as string[],
      })),
      markSent: vi.fn(async () => {}),
      listSent: vi.fn(async () => []),
    },
    deliver: vi.fn(async () => 'provider-id'),
  }
  const resolve = vi.fn<MailWorkspaceAuthority['resolve']>(async () => ({
    status: 'ok',
    workspace: { id: 'workspace-a', name: 'Workspace', slug: 'workspace-a', role: 'owner' },
  }))
  const app = createApp({
    config: {
      appEnv: 'development',
      databaseUrl: 'postgresql://localhost/test',
      host: 'localhost',
      port: 8080,
      logLevel: 'silent',
      apiDocsEnabled: true,
      serviceVersion: 'test',
      otlpEndpoint: undefined,
      otelTraceSampleRate: 0,
      serviceInstanceId: 'test',
    },
    logger: pino({ enabled: false }),
    checkDatabase: async () => {},
    auth: {
      handler: async () => new Response(),
      api: {
        getSession: async () =>
          authenticated ? { session: { id: 'session' }, user: { id: 'owner' } } : null,
      },
    },
    mailWorkspaceAuthority: { resolve },
    mailWorkspaceBaseOrigin: 'https://app.example.test',
    allowedAuthOrigins: ['https://mail.example.test', 'https://alpha.app.example.test'],
    outgoingMail,
    ...(workspace ? { workspaces: { reader: {} as never, consumeBudget: vi.fn() } } : {}),
  })
  const send = (body: unknown = input, origin = 'https://mail.example.test') =>
    app.request('/api/v1/mail/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    })
  return { app, outgoingMail, send, resolve }
}
describe('outgoing mail HTTP', () => {
  it('sends authenticated mail and returns a private confirmed response', async () => {
    const { send, outgoingMail } = setup()
    const response = await send()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: input.id, status: 'sent' })
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(outgoingMail.repository.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner' }),
    )
  })
  it('requires authentication before sending or listing', async () => {
    const { send, app, outgoingMail } = setup(false)
    expect((await send()).status).toBe(401)
    expect((await app.request('/api/v1/mail/sent')).status).toBe(401)
    expect(outgoingMail.deliver).not.toHaveBeenCalled()
    expect(outgoingMail.repository.listSent).not.toHaveBeenCalled()
  })
  it('rejects foreign origins', async () => {
    const { send, outgoingMail } = setup()
    expect((await send(input, 'https://evil.test')).status).toBe(403)
    expect(outgoingMail.deliver).not.toHaveBeenCalled()
  })
  it.each([
    { ...input, to: [], cc: [], bcc: [] },
    { ...input, to: ['bad'] },
    { ...input, from: 'spoof@example.test' },
    { ...input, workspaceId: 'spoof-workspace' },
    { ...input, attachments: [{ filename: 'hello.txt', content: 'invalid base64!' }] },
    { ...input, to: Array(51).fill('ada@example.test') },
  ])('rejects invalid send input without delivery', async (body) => {
    const { send, outgoingMail } = setup()
    expect((await send(body)).status).toBe(400)
    expect(outgoingMail.deliver).not.toHaveBeenCalled()
  })
  it('rejects Bcc-only messages before calling Resend', async () => {
    const { send } = setup()
    expect((await send({ ...input, to: [], bcc: ['hidden@example.test'] })).status).toBe(400)
  })
  it('does not leak provider errors', async () => {
    const { send, outgoingMail } = setup()
    outgoingMail.deliver.mockRejectedValueOnce(new Error('private provider data'))
    const response = await send()
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('private provider data')
  })
  it('lists only the current user confirmed messages with bounded pagination', async () => {
    const { app, outgoingMail } = setup()
    expect((await app.request('/api/v1/mail/sent?offset=20')).status).toBe(200)
    expect(outgoingMail.repository.listSent).toHaveBeenCalledWith(
      { userId: 'owner', workspaceId: 'workspace-a' },
      20,
    )
    expect((await app.request('/api/v1/mail/sent?offset=-1')).status).toBe(400)
  })
  it('authorizes scoped writes and Sent even with workspace UI enabled', async () => {
    const { send, app, outgoingMail } = setup(true, true)
    expect((await send()).status).toBe(200)
    expect(outgoingMail.deliver).toHaveBeenCalledOnce()
    expect((await app.request('/api/v1/mail/sent')).status).toBe(200)
  })
})

it('rejects legacy Base64 attachments with an actionable error', async () => {
  const { send, outgoingMail } = setup()
  const response = await send({
    ...input,
    attachments: [{ filename: 'file.txt', content: 'c2VjcmV0' }],
  })
  expect(response.status).toBe(400)
  const body = await response.json()
  expect(body.code).toBe('legacy_attachment_unsupported')
  expect(body.detail).toContain('upload')
  expect(JSON.stringify(body)).not.toContain('c2VjcmV0')
  expect(outgoingMail.deliver).not.toHaveBeenCalled()
})

it('limits oversized legacy bodies before parsing', async () => {
  const { send } = setup()
  expect(
    (
      await send({
        ...input,
        attachments: [
          { filename: 'large.bin', content: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') },
        ],
      })
    ).status,
  ).toBe(413)
})

it('rejects malformed JSON without exposing parsing errors', async () => {
  const { app } = setup()
  const response = await app.request('/api/v1/mail/send', {
    method: 'POST',
    headers: { origin: 'https://mail.example.test', 'content-type': 'application/json' },
    body: '{bad json',
  })
  expect(response.status).toBe(400)
})

describe('discard HTTP boundary', () => {
  const body = { messageIds: [input.id], attachmentIds: [] }
  function discard(
    app: ReturnType<typeof setup>['app'],
    value: unknown = body,
    origin = 'https://mail.example.test',
  ) {
    return app.request('/api/v1/mail/discard', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    })
  }
  it('scopes cancellation to the verified owner and workspace and returns retained ids', async () => {
    const { app, outgoingMail } = setup()
    outgoingMail.repository.discard.mockResolvedValueOnce({
      status: 'discarded',
      retainedMessageIds: [input.id],
    })
    const response = await discard(app)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'discarded', retainedMessageIds: [input.id] })
    expect(outgoingMail.repository.discard).toHaveBeenCalledWith(
      { userId: 'owner', workspaceId: 'workspace-a' },
      body,
    )
    expect(response.headers.get('cache-control')).toContain('no-store')
  })
  it('requires authentication and a trusted Origin before cancellation', async () => {
    const authenticated = setup()
    const unauthenticated = setup(false)
    expect((await discard(unauthenticated.app)).status).toBe(401)
    expect((await discard(authenticated.app, body, 'https://evil.test')).status).toBe(403)
    expect((await discard(authenticated.app, body, '')).status).toBe(403)
    expect(authenticated.outgoingMail.repository.discard).not.toHaveBeenCalled()
  })
  it.each([
    { messageIds: ['invalid'], attachmentIds: [] },
    { messageIds: [], attachmentIds: [], workspaceId: 'forged' },
    { messageIds: Array(101).fill(input.id), attachmentIds: [] },
  ])('rejects invalid cancellation payloads', async (value) => {
    const { app, outgoingMail } = setup()
    expect((await discard(app, value)).status).toBe(400)
    expect(outgoingMail.repository.discard).not.toHaveBeenCalled()
  })
  it('rejects malformed or oversized cancellation bodies before repository work', async () => {
    const { app, outgoingMail } = setup()
    const headers = { origin: 'https://mail.example.test', 'content-type': 'application/json' }
    expect(
      (await app.request('/api/v1/mail/discard', { method: 'POST', headers, body: '{invalid' }))
        .status,
    ).toBe(400)
    expect(
      (
        await app.request('/api/v1/mail/discard', {
          method: 'POST',
          headers,
          body: JSON.stringify({ payload: 'x'.repeat(20_000) }),
        })
      ).status,
    ).toBe(413)
    expect(outgoingMail.repository.discard).not.toHaveBeenCalled()
  })
  it('retains the local draft through a retryable sanitized cancellation failure', async () => {
    const { app, outgoingMail } = setup()
    outgoingMail.repository.discard.mockRejectedValueOnce(new Error('private database metadata'))
    const response = await discard(app)
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('private database metadata')
  })
})

describe('workspace-scoped Sent HTTP', () => {
  it('returns verified scope headers for both context discovery and Sent', async () => {
    const { app, outgoingMail, resolve } = setup()
    for (const path of ['/api/v1/mail/context', '/api/v1/mail/sent']) {
      const response = await app.request(path, {
        headers: {
          'X-Workspace-Identity': 'owner',
          'X-Workspace-Id': 'workspace-a',
          Origin: 'https://mail.example.test',
        },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('X-Workspace-Identity')).toBe('owner')
      expect(response.headers.get('X-Workspace-Id')).toBe('workspace-a')
      expect(response.headers.get('cache-control')).toContain('private')
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('access-control-expose-headers')).toContain('X-Workspace-Id')
    }
    expect(resolve).toHaveBeenCalledWith('owner', { workspaceId: 'workspace-a' })
    expect(outgoingMail.repository.listSent).toHaveBeenCalledWith(
      { userId: 'owner', workspaceId: 'workspace-a' },
      0,
    )
  })
  it('uses the selected workspace rather than the account default for Sent', async () => {
    const { app, outgoingMail, resolve } = setup()
    resolve.mockResolvedValueOnce({
      status: 'ok',
      workspace: { id: 'workspace-b', name: 'Beta', slug: 'beta', role: 'member' },
    })
    const response = await app.request('/api/v1/mail/sent?offset=5', {
      headers: { 'X-Workspace-Id': 'workspace-b', 'X-Workspace-Identity': 'owner' },
    })
    expect(response.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith('owner', { workspaceId: 'workspace-b' })
    expect(outgoingMail.repository.listSent).toHaveBeenCalledWith(
      { userId: 'owner', workspaceId: 'workspace-b' },
      5,
    )
    expect(response.headers.get('X-Workspace-Id')).toBe('workspace-b')
  })
  it('requires an unambiguous authorized workspace even with workspace UI disabled', async () => {
    const { app, outgoingMail, resolve } = setup()
    for (const status of ['required', 'unavailable'] as const) {
      resolve.mockResolvedValueOnce({ status })
      const response = await app.request('/api/v1/mail/sent')
      expect(response.status).toBe(status === 'required' ? 409 : 403)
      expect(outgoingMail.repository.listSent).not.toHaveBeenCalled()
    }
  })
  it('rejects a changed actor and revalidates selector against the tenant Origin', async () => {
    const { app, outgoingMail, resolve } = setup()
    expect(
      (await app.request('/api/v1/mail/sent', { headers: { 'X-Workspace-Identity': 'foreign' } }))
        .status,
    ).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
    resolve.mockResolvedValueOnce({ status: 'unavailable' })
    expect(
      (
        await app.request('/api/v1/mail/sent', {
          headers: { Origin: 'https://alpha.app.example.test', 'X-Workspace-Id': 'workspace-b' },
        })
      ).status,
    ).toBe(403)
    expect(resolve).toHaveBeenCalledWith('owner', { workspaceId: 'workspace-b', slug: 'alpha' })
    expect(outgoingMail.repository.listSent).not.toHaveBeenCalled()
  })
})
