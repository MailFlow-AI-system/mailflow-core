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
    { ...input, attachments: [{ filename: 'hello.txt', content: 'invalid base64!' }] },
    { ...input, to: Array(51).fill('ada@example.test') },
    {
      ...input,
      attachments: [
        { filename: 'large.bin', content: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') },
      ],
    },
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
  it('preserves workspace isolation', async () => {
    const { send, outgoingMail } = setup(true, true)
    expect((await send()).status).toBe(503)
    expect(outgoingMail.deliver).not.toHaveBeenCalled()
  })
})
