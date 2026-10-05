import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it, vi } from 'vitest'
import { installAuthRoutes } from '../infrastructure/auth/route.js'
import { createWorkspaceEntryRoutes } from './entryRoute.js'
import type { WorkspaceEntry } from './entryTypes.js'

function fixture(authenticated = true) {
  const reader = {
    resolve: vi.fn(async (): Promise<WorkspaceEntry> => ({ source: 'none', workspace: null })),
  }
  const consumeBudget = vi.fn(async () => 0)
  const app = new OpenAPIHono()
  installAuthRoutes(app, {
    auth: {
      handler: async () => Response.json(null),
      api: {
        getSession: async () =>
          authenticated ? { user: { id: 'actor' }, session: { id: 'session' } } : null,
      },
    },
    allowedOrigins: ['http://localhost:3000'],
  })
  app.route('/', createWorkspaceEntryRoutes({ reader, consumeBudget }))
  return { app, reader, consumeBudget }
}

describe('workspace entry HTTP contract', () => {
  it('requires authentication before reading a preference or consuming budget', async () => {
    const { app, reader, consumeBudget } = fixture(false)
    expect((await app.request('/api/v1/workspace-entry')).status).toBe(401)
    expect(reader.resolve).not.toHaveBeenCalled()
    expect(consumeBudget).not.toHaveBeenCalled()
  })
  it('uses only the authenticated actor and returns a private empty outcome', async () => {
    const { app, reader } = fixture()
    const response = await app.request('/api/v1/workspace-entry')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ source: 'none', workspace: null })
    expect(reader.resolve).toHaveBeenCalledWith('actor')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })
  it('rejects actor, selector and redirect parameters before reading preferences', async () => {
    const { app, reader } = fixture()
    for (const query of ['userId=other', 'workspaceId=other', 'redirect=https://attacker.test']) {
      const response = await app.request(`/api/v1/workspace-entry?${query}`)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'invalid_workspace_request' })
    }
    expect(reader.resolve).not.toHaveBeenCalled()
  })
  it('returns a retry budget without reading workspace data', async () => {
    const { app, reader, consumeBudget } = fixture()
    consumeBudget.mockResolvedValue(17)
    const response = await app.request('/api/v1/workspace-entry')
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('17')
    expect(reader.resolve).not.toHaveBeenCalled()
  })
})
