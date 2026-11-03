import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it, vi } from 'vitest'
import { createLabelRoutes } from './route.js'

const label = { id: '00000000-0000-4000-8000-000000000001', name: 'Invoice', color: '#2563eb' }
const messageId = '00000000-0000-4000-8000-000000000002'

function setup(authenticated = true) {
  const repository = {
    searchLabels: vi.fn().mockResolvedValue({ items: [], nextCursor: null, exactMatch: label }),
    suggestColor: vi.fn().mockResolvedValue('#9333ea'),
    createLabel: vi.fn().mockResolvedValue(label),
    messageLabels: vi.fn().mockResolvedValue([label]),
    changeMessageLabel: vi.fn().mockResolvedValue([label]),
  }
  const resolveWorkspace = vi.fn().mockResolvedValue({ id: 'workspace-a' })
  const app = new OpenAPIHono()
  app.use('*', async (c, next) => {
    if (authenticated) c.set('authSession', { user: { id: 'user-a' }, session: { id: 's' } })
    await next()
  })
  app.route(
    '/',
    createLabelRoutes(repository, resolveWorkspace, () => true),
  )
  return { app, repository, resolveWorkspace }
}

describe('workspace labels', () => {
  it('returns global exact match and passes trimmed search and cursor', async () => {
    const { app, repository } = setup()
    const response = await app.request('/api/v1/workspaces/acme/mail/labels?q=%20invoice%20')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [], nextCursor: null, exactMatch: label })
    expect(repository.searchLabels).toHaveBeenCalledWith('workspace-a', 'invoice', null)
  })
  it('rejects malformed, noncanonical, oversized, and extra-field cursors', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const valid = encode({ name: 'Invoice', id: label.id })
    for (const cursor of [
      '',
      `${valid}=`,
      'a'.repeat(1025),
      encode({ name: 'Invoice', id: label.id, extra: true }),
    ]) {
      const { app, repository } = setup()
      const response = await app.request(
        `/api/v1/workspaces/acme/mail/labels?cursor=${encodeURIComponent(cursor)}`,
      )
      expect(response.status).toBe(400)
      expect(repository.searchLabels).not.toHaveBeenCalled()
    }
  })
  it('accepts a canonical cursor containing the longest valid escaped Unicode name', async () => {
    const { app, repository } = setup()
    const cursor = { name: '\u0001'.repeat(100), id: label.id }
    const encoded = Buffer.from(JSON.stringify(cursor)).toString('base64url')
    expect(
      (await app.request(`/api/v1/workspaces/acme/mail/labels?cursor=${encoded}`)).status,
    ).toBe(200)
    expect(repository.searchLabels).toHaveBeenCalledWith('workspace-a', '', cursor)
  })
  it('creates a normalized label and returns persisted data', async () => {
    const { app, repository } = setup()
    const response = await app.request('/api/v1/workspaces/acme/mail/labels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: ' Invoice ', color: label.color }),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual(label)
    expect(repository.createLabel).toHaveBeenCalledWith('workspace-a', 'Invoice', label.color)
  })
  it('returns a workspace recommendation and rejects colors outside the palette', async () => {
    const { app, repository } = setup()
    const response = await app.request('/api/v1/workspaces/acme/mail/labels/palette')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      colors: expect.arrayContaining(['#9333ea']),
      suggestedColor: '#9333ea',
    })
    expect(repository.suggestColor).toHaveBeenCalledWith('workspace-a')
    const invalid = await app.request('/api/v1/workspaces/acme/mail/labels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Invoice', color: '#ffffff' }),
    })
    expect(invalid.status).toBe(400)
    expect(repository.createLabel).not.toHaveBeenCalled()
  })
  it('rejects invalid names and unauthenticated requests', async () => {
    const { app, repository } = setup()
    expect(
      (
        await app.request('/api/v1/workspaces/acme/mail/labels', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: ' ' }),
        })
      ).status,
    ).toBe(400)
    expect(repository.createLabel).not.toHaveBeenCalled()
    expect((await setup(false).app.request('/api/v1/workspaces/acme/mail/labels')).status).toBe(401)
  })
  it('rejects NUL characters before they reach PostgreSQL', async () => {
    const { app, repository } = setup()
    expect((await app.request('/api/v1/workspaces/acme/mail/labels?q=%00')).status).toBe(400)
    expect(
      (
        await app.request('/api/v1/workspaces/acme/mail/labels', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'a\u0000b' }),
        })
      ).status,
    ).toBe(400)
    expect(repository.searchLabels).not.toHaveBeenCalled()
    expect(repository.createLabel).not.toHaveBeenCalled()
  })
  it('returns the current labels after a sent message mutation', async () => {
    const { app, repository } = setup()
    const response = await app.request(
      `/api/v1/workspaces/acme/mail/sent/${messageId}/labels/${label.id}`,
      { method: 'PUT' },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [label] })
    expect(repository.changeMessageLabel).toHaveBeenCalledWith(
      'workspace-a',
      'user-a',
      'sent',
      messageId,
      label.id,
      true,
    )
  })
})
