import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../app.js'

const workspace = { id: 'workspace-a', name: 'Alpha', slug: 'alpha', role: 'owner' as const }
function setup({ authenticated = true, hasAuthority = true, workspaceMode = false } = {}) {
  const resolve = vi.fn(async () => ({ status: 'ok' as const, workspace }))
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
          authenticated ? { session: { id: 'session' }, user: { id: 'user-a' } } : null,
      },
    },
    allowedAuthOrigins: ['https://mail.example.test'],
    ...(hasAuthority ? { mailWorkspaceAuthority: { resolve } } : {}),
    ...(workspaceMode ? { workspaces: { reader: {} as never, consumeBudget: vi.fn() } } : {}),
  })
  return { app, resolve }
}
describe('mail context API', () => {
  it('works with workspace UI flags disabled and returns the authorized context', async () => {
    const { app, resolve } = setup()
    const response = await app.request('/api/v1/mail/context', {
      headers: { 'X-Workspace-Id': workspace.id },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ userId: 'user-a', workspace })
    expect(resolve).toHaveBeenCalledWith('user-a', { workspaceId: workspace.id })
  })
  it('requires authentication and fails closed without authority', async () => {
    expect((await setup({ authenticated: false }).app.request('/api/v1/mail/context')).status).toBe(
      401,
    )
    const unavailable = await setup({ hasAuthority: false }).app.request('/api/v1/mail/context')
    expect(unavailable.status).toBe(503)
    expect((await unavailable.json()).code).toBe('workspace_unavailable')
    expect(
      (
        await setup({ hasAuthority: false }).app.request('/api/v1/mail/send', {
          method: 'POST',
          headers: { Origin: 'https://mail.example.test' },
        })
      ).status,
    ).toBe(503)
  })
  it('preserves legacy list guard in workspace mode while allowing context', async () => {
    const { app } = setup({ workspaceMode: true })
    expect((await app.request('/api/v1/mail/context')).status).toBe(200)
    expect((await app.request('/api/v1/mail/messages')).status).toBe(503)
    expect((await app.request('/api/v1/mail/messages', { method: 'HEAD' })).status).toBe(503)
    expect((await app.request('/api/v1/mail/sent')).status).toBe(503)
  })
})
