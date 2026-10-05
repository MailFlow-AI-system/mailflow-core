import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it, vi } from 'vitest'
import { installAuthRoutes } from '../infrastructure/auth/route.js'
import { createWorkspaceRoutes } from './route.js'

function fixture(authenticated = true) {
  const app = new OpenAPIHono()
  const handler = vi.fn(async () => Response.json({ delegated: true }))
  const reader = {
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    context: vi.fn(async () => null),
  }
  const budget = vi.fn(async () => 0)
  installAuthRoutes(app, {
    auth: {
      handler,
      api: {
        getSession: async () =>
          authenticated ? { user: { id: 'actor' }, session: { id: 'session' } } : null,
      },
    },
    allowedOrigins: ['http://localhost:3000'],
  })
  app.route('/', createWorkspaceRoutes(reader, budget))
  return { app, reader, handler, budget }
}

describe('workspace HTTP contracts', () => {
  it('does not install workspace authority on unrelated routes', async () => {
    const { app, budget } = fixture(false)
    app.get('/health', (context) => context.json({ live: true }))
    expect((await app.request('/health')).status).toBe(200)
    expect(budget).not.toHaveBeenCalled()
  })
  it('requires a session before discovery or consuming budget', async () => {
    const { app, reader, budget } = fixture(false)
    expect((await app.request('/api/v1/workspaces')).status).toBe(401)
    expect(reader.list).not.toHaveBeenCalled()
    expect(budget).not.toHaveBeenCalled()
  })
  it('ignores an actor supplied by the browser and responds privately', async () => {
    const { app, reader } = fixture()
    const response = await app.request('/api/v1/workspaces?userId=other')
    expect(reader.list).toHaveBeenCalledWith('actor', undefined)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ items: [], nextCursor: null })
  })
  it('uses the same unavailable response for absent and unauthorized workspaces', async () => {
    const { app } = fixture()
    const response = await app.request('/api/v1/workspaces/unknown/context')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'workspace_unavailable' })
  })
  it('validates selectors and limits before querying tenant data', async () => {
    const { app, reader, budget } = fixture()
    expect((await app.request('/api/v1/workspaces/INVALID/context')).status).toBe(400)
    expect(reader.context).not.toHaveBeenCalled()
    budget.mockResolvedValue(37)
    const limited = await app.request('/api/v1/workspaces')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('37')
    expect(reader.list).not.toHaveBeenCalled()
  })
  it.each(['organization/list', 'organization/create', '%6frganization/list'])(
    'closes plugin HTTP surface %s',
    async (path) => {
      const { app, handler } = fixture()
      expect((await app.request(`/api/auth/${path}`)).status).toBe(404)
      expect(handler).not.toHaveBeenCalled()
    },
  )
})
