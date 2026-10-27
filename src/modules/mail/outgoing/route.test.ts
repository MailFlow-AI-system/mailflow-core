import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
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
    mailWorkspaceAuthority: {
      resolve: vi.fn(async () => ({
        status: 'ok' as const,
        workspace: {
          id: 'workspace-a',
          name: 'Workspace',
          slug: 'workspace-a',
          role: 'owner' as const,
        },
      })),
    },
    allowedAuthOrigins: ['https://mail.example.test'],
    outgoingMail,
    ...(workspace ? { workspaces: { reader: {} as never, consumeBudget: vi.fn() } } : {}),
  })
  const send = (body: unknown = input, origin = 'https://mail.example.test') =>
    app.request('/api/v1/mail/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    })
  return { app, outgoingMail, send }
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
    expect(outgoingMail.repository.listSent).toHaveBeenCalledWith('owner', 20)
    expect((await app.request('/api/v1/mail/sent?offset=-1')).status).toBe(400)
  })
  it('authorizes scoped writes while retaining the legacy list guard', async () => {
    const { send, app, outgoingMail } = setup(true, true)
    expect((await send()).status).toBe(200)
    expect(outgoingMail.deliver).toHaveBeenCalledOnce()
    expect((await app.request('/api/v1/mail/sent')).status).toBe(503)
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
