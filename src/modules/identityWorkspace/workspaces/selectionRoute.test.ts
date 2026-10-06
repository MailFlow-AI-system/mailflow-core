import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it, vi } from 'vitest'
import { installAuthRoutes } from '../infrastructure/auth/route.js'
import { createWorkspaceSelectionRoutes } from './selectionRoute.js'
import type { WorkspaceSelection } from './types.js'

const origin = 'http://acme.workspace.test:3003'
function fixture(authenticated = true) {
  const app = new OpenAPIHono()
  const select = vi.fn<WorkspaceSelection['select']>(async () => ({
    id: 'target',
    name: 'Target',
    slug: 'target',
    role: 'member' as const,
  }))
  const consumeBudget = vi.fn(async () => 0)
  installAuthRoutes(app, {
    auth: {
      handler: async () => new Response(null),
      api: {
        getSession: async () =>
          authenticated ? { session: { id: 'session' }, user: { id: 'actor' } } : null,
      },
    },
    allowedOrigins: [origin],
  })
  app.route(
    '/',
    createWorkspaceSelectionRoutes({
      selection: { select },
      consumeBudget,
      allowedOrigins: [origin],
    }),
  )
  return { app, select, consumeBudget }
}
function request(body: unknown = { workspaceId: 'target' }, requestOrigin = origin) {
  return new Request('http://localhost/api/v1/workspace-selection', {
    method: 'POST',
    headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
describe('workspace selection HTTP contract', () => {
  it('does not write a preference when an old tab expects a different identity', async () => {
    const { app, select, consumeBudget } = fixture()
    const input = request()
    input.headers.set('X-Workspace-Identity', 'previous-actor')
    const response = await app.request(input)
    expect(response.status).toBe(403)
    expect(response.headers.get('x-workspace-identity')).toBe('actor')
    expect(select).not.toHaveBeenCalled()
    expect(consumeBudget).not.toHaveBeenCalled()
  })
  it('selects only for the session identity and returns no redirect or session mutation', async () => {
    const { app, select } = fixture()
    const response = await app.request(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      workspace: { id: 'target', name: 'Target', slug: 'target', role: 'member' },
    })
    expect(select).toHaveBeenCalledWith('actor', 'target')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
  })
  it('rejects missing sessions before consuming a budget or changing preferences', async () => {
    const { app, select, consumeBudget } = fixture(false)
    expect((await app.request(request())).status).toBe(401)
    expect(select).not.toHaveBeenCalled()
    expect(consumeBudget).not.toHaveBeenCalled()
  })
  it.each(['null', '', 'http://evil.workspace.test:3003', 'https://untrusted.example'])(
    'rejects origin %s',
    async (untrustedOrigin) => {
      const { app, select } = fixture()
      expect((await app.request(request(undefined, untrustedOrigin))).status).toBe(403)
      expect(select).not.toHaveBeenCalled()
    },
  )
  it.each([
    { workspaceId: '' },
    { workspaceId: 'target', userId: 'other' },
    { workspaceId: 'target', redirect: 'https://evil.test' },
  ])('rejects forged selectors and additional authority', async (body) => {
    const { app, select } = fixture()
    expect((await app.request(request(body))).status).toBe(400)
    expect(select).not.toHaveBeenCalled()
  })
  it('bounds payload size and consumes the identity-scoped budget', async () => {
    const { app, select, consumeBudget } = fixture()
    expect((await app.request(request({ workspaceId: 'a'.repeat(2000) }))).status).toBe(413)
    consumeBudget.mockResolvedValue(24)
    const limited = await app.request(request())
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('24')
    expect(select).not.toHaveBeenCalled()
  })
  it('uses one unavailable result for absent and unauthorized workspaces', async () => {
    const { app, select } = fixture()
    select.mockResolvedValueOnce(null)
    const response = await app.request(request())
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'workspace_unavailable' })
  })
})
