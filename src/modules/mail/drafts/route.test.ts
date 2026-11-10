import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it, vi } from 'vitest'
import { requireMailCapability } from '../context/capabilityPolicy.js'
import { DraftConflictError } from './contract.js'
import { createDraftRoutes } from './route.js'

function setup(capabilities = ['mail.read', 'mail.compose']) {
  const repository = {
    list: vi.fn(async () => []),
    find: vi.fn(async () => null),
    save: vi.fn(async () => ({ version: 1 })),
    discard: vi.fn(async () => {}),
    discardMany: vi.fn(async (_context: unknown, items: { id: string }[]) =>
      items.map(({ id }) => ({ id, status: 'discarded' })),
    ),
    complete: vi.fn(),
  }
  const app = new OpenAPIHono()
  app.use('*', async (c, next) => {
    c.set('mailContext', { userId: 'owner', workspaceId: 'workspace' })
    c.set('mailCapabilities', capabilities)
    await next()
  })
  app.use('*', requireMailCapability)
  app.route(
    '/',
    createDraftRoutes(repository as never, (origin) => origin === 'https://mail.test'),
  )
  return { app, repository }
}
const input = {
  version: 0,
  mutationId: randomUUID(),
  to: 'unfinished@',
  cc: '',
  bcc: '',
  recipientName: '',
  subject: '',
  html: '<p>Draft</p>',
  text: 'Draft',
  attachments: [],
  labelIds: [],
}
const headers: Record<string, string> = {
  Origin: 'https://mail.test',
  'Content-Type': 'application/json',
}
describe('draft routes', () => {
  it('keeps draft middleware scoped when mounted alongside other modules', async () => {
    const app = new OpenAPIHono()
    app.route(
      '/',
      createDraftRoutes({} as never, () => false),
    )
    app.put('/unrelated', (c) => c.text('unrelated'))
    expect((await app.request('/unrelated', { method: 'PUT' })).status).toBe(200)
  })
  it('accepts incomplete compositions and forwards only the authenticated scope', async () => {
    const { app, repository } = setup()
    const id = randomUUID()
    const response = await app.request(`/api/v1/mail/drafts/${id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(input),
    })
    expect(response.status).toBe(200)
    expect(repository.save).toHaveBeenCalledWith(
      { userId: 'owner', workspaceId: 'workspace' },
      id,
      input,
    )
  })
  it('enforces read/compose permissions and trusted mutation origins', async () => {
    const id = randomUUID()
    const { app, repository } = setup(['mail.read'])
    expect((await app.request('/api/v1/mail/drafts')).status).toBe(200)
    expect(
      (
        await app.request(`/api/v1/mail/drafts/${id}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(403)
    expect(repository.save).not.toHaveBeenCalled()
    const authorized = setup()
    for (const origin of [undefined, 'https://evil.test']) {
      expect(
        (
          await authorized.app.request(`/api/v1/mail/drafts/${id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
            body: JSON.stringify({ version: 1 }),
          })
        ).status,
      ).toBe(403)
    }
    expect(authorized.repository.discard).not.toHaveBeenCalled()
  })
  it('rejects malformed payloads, duplicate references and invalid pagination', async () => {
    const { app, repository } = setup()
    const id = randomUUID()
    for (const body of [
      '{',
      JSON.stringify({ ...input, userId: 'foreign' }),
      JSON.stringify({ ...input, attachments: [{ id }, { id }] }),
    ]) {
      expect(
        (await app.request(`/api/v1/mail/drafts/${id}`, { method: 'PUT', headers, body })).status,
      ).toBe(400)
    }
    expect((await app.request('/api/v1/mail/drafts?offset=-1')).status).toBe(400)
    expect(repository.save).not.toHaveBeenCalled()
  })
  it('forwards a trimmed search text and rejects oversized searches', async () => {
    const { app, repository } = setup()
    expect((await app.request('/api/v1/mail/drafts?q=%20invoice%20&offset=20')).status).toBe(200)
    expect(repository.list).toHaveBeenLastCalledWith(
      { userId: 'owner', workspaceId: 'workspace' },
      20,
      'invoice',
    )
    expect((await app.request('/api/v1/mail/drafts')).status).toBe(200)
    expect(repository.list).toHaveBeenLastCalledWith(
      { userId: 'owner', workspaceId: 'workspace' },
      0,
      '',
    )
    expect((await app.request(`/api/v1/mail/drafts?q=${'a'.repeat(201)}`)).status).toBe(400)
  })
  it('discards several drafts and reports each outcome without hiding conflicts', async () => {
    const { app, repository } = setup()
    const items = [
      { id: randomUUID(), version: 1 },
      { id: randomUUID(), version: 4 },
    ]
    repository.discardMany.mockResolvedValueOnce([
      { id: items[0]?.id ?? '', status: 'discarded' },
      { id: items[1]?.id ?? '', status: 'conflict' },
    ])
    const response = await app.request('/api/v1/mail/drafts/discard', {
      method: 'POST',
      headers,
      body: JSON.stringify({ items }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      results: [
        { id: items[0]?.id, status: 'discarded' },
        { id: items[1]?.id, status: 'conflict' },
      ],
    })
    expect(repository.discardMany).toHaveBeenCalledWith(
      { userId: 'owner', workspaceId: 'workspace' },
      items,
    )
  })
  it('protects bulk discard with compose permission, trusted origin and a bounded payload', async () => {
    const valid = { items: [{ id: randomUUID(), version: 1 }] }
    const send = (app: ReturnType<typeof setup>['app'], body: unknown, extra = headers) =>
      app.request('/api/v1/mail/drafts/discard', {
        method: 'POST',
        headers: extra,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    const readOnly = setup(['mail.read'])
    expect((await send(readOnly.app, valid)).status).toBe(403)
    const { app, repository } = setup()
    expect((await send(app, valid, { 'Content-Type': 'application/json' })).status).toBe(403)
    expect((await send(app, valid, { ...headers, Origin: 'https://evil.test' })).status).toBe(403)
    for (const body of [
      '{',
      { items: [] },
      { items: [{ id: 'not-a-uuid', version: 1 }] },
      { items: [{ id: randomUUID(), version: 0 }] },
      {
        items: [
          { id: valid.items[0]?.id, version: 1 },
          { id: valid.items[0]?.id, version: 1 },
        ],
      },
      {
        items: Array.from({ length: 51 }, () => ({ id: randomUUID(), version: 1 })),
      },
      { ...valid, userId: 'foreign' },
    ])
      expect((await send(app, body)).status).toBe(400)
    expect(repository.discardMany).not.toHaveBeenCalled()
  })
  it('reports conflicts and does not invent successful saves', async () => {
    const { app, repository } = setup()
    repository.save.mockRejectedValueOnce(new DraftConflictError())
    const response = await app.request(`/api/v1/mail/drafts/${randomUUID()}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(input),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'draft_conflict' })
    expect((await app.request(`/api/v1/mail/drafts/${randomUUID()}`)).status).toBe(404)
  })
})
