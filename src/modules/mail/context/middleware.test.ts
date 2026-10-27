import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { MailWorkspaceResolution } from '#modules/identityWorkspace'
import { createMailContextMiddleware } from './middleware.js'

const workspace = { id: 'workspace-a', name: 'Alpha', slug: 'alpha', role: 'owner' as const }
function setup(result: MailWorkspaceResolution = { status: 'ok', workspace }) {
  const resolve = vi.fn(async () => result)
  const app = new Hono()
  app.use('*', async (context, next) => {
    context.set('authSession', { user: { id: 'user-a' }, session: { id: 'session' } })
    await next()
  })
  app.use(
    '*',
    createMailContextMiddleware(
      { resolve },
      {
        isAllowedOrigin: (origin) => origin === 'https://alpha.app.example.test',
        workspaceBaseOrigin: 'https://app.example.test',
      },
    ),
  )
  app.get('/', (context) => context.json(context.get('mailContext')))
  return { app, resolve }
}
describe('mail workspace authorization', () => {
  it('sets trusted actor and workspace using membership validation', async () => {
    const { app, resolve } = setup()
    const response = await app.request('/', {
      headers: { Origin: 'https://alpha.app.example.test', 'X-Workspace-Id': 'workspace-a' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ workspaceId: 'workspace-a', userId: 'user-a' })
    expect(resolve).toHaveBeenCalledWith('user-a', { workspaceId: 'workspace-a', slug: 'alpha' })
  })
  it('fails closed when workspace choice is required or unauthorized', async () => {
    expect((await setup({ status: 'required' }).app.request('/')).status).toBe(409)
    expect((await setup({ status: 'unavailable' }).app.request('/')).status).toBe(403)
  })
  it('rejects stale identity and untrusted origin without querying authority', async () => {
    const { app, resolve } = setup()
    expect((await app.request('/', { headers: { 'X-Workspace-Identity': 'user-b' } })).status).toBe(
      403,
    )
    expect((await app.request('/', { headers: { Origin: 'https://evil.test' } })).status).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
  })
  it('fails closed when authority is unavailable', async () => {
    const { app, resolve } = setup()
    resolve.mockRejectedValueOnce(new Error('db'))
    expect((await app.request('/')).status).toBe(503)
  })
})
