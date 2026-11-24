import { createHash } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadAuthConfig } from '../infrastructure/auth/authConfig.js'
import { RESOLVED_CLIENT_IP_HEADER } from '../infrastructure/auth/clientIp.js'
import { createAuth } from '../infrastructure/auth/createAuth.js'
import { testClientIp } from '../onboarding/utils/testClientIp.test-support.js'
import { createAccountWorkspaceResolver } from './accountWorkspace.js'
import { createWorkspaceTestFixture } from './fixtures.test-support.js'
import { createWorkspaceHandoffStore } from './workspaceHandoff.js'

describe('workspace handoff with real PostgreSQL privileges', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceTestFixture>>
  let auth: ReturnType<typeof createAuth>
  let config: ReturnType<typeof loadAuthConfig>
  const origin = (slug: string) => `https://${slug}.example.com`

  beforeAll(async () => {
    fixture = await createWorkspaceTestFixture()
    config = loadAuthConfig({
      APP_ENV: 'production',
      BETTER_AUTH_SECRET: fixture.authConfig.secret,
      BETTER_AUTH_URL: 'https://api.example.com',
      SITE_URL: 'https://example.com',
      WORKSPACE_WEB_BASE_ORIGIN: 'https://example.com',
      WORKSPACE_SWITCHING_ENABLED: 'true',
      WORKSPACE_READ_ENABLED: 'true',
      RESEND_API_KEY: 'no-external-delivery',
      RESEND_FROM_EMAIL: 'noreply@mailflow.invalid',
    })
    auth = createAuth(
      drizzle(fixture.pool),
      config,
      async () => {},
      () => {},
      {
        accountWorkspace: createAccountWorkspaceResolver(fixture.pool),
        workspaceHandoff: createWorkspaceHandoffStore(fixture.pool),
      },
    )
  })
  afterAll(async () => {
    await fixture?.close()
  })

  const post = (path: string, body: unknown, from: string, cookie?: string, ip = testClientIp()) =>
    auth.handler(
      new Request(`${config.baseURL}/api/auth${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: from,
          [RESOLVED_CLIENT_IP_HEADER]: ip,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    )
  const sessionCookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0] ?? '')
      .filter((pair) => pair.startsWith('__Secure-better-auth.session_token='))
      .join('; ')
  async function signIn(slug: string) {
    const response = await post(
      '/sign-in/email',
      { email: fixture.email, password: fixture.password },
      origin(slug),
    )
    expect(response.status).toBe(200)
    return response
  }
  async function issue(cookie: string, workspaceId: string, from = origin(fixture.acmeSlug)) {
    return post('/workspace-handoff/issue', { workspaceId }, from, cookie)
  }
  async function issuedCode(cookie: string, workspaceId: string) {
    const response = await issue(cookie, workspaceId)
    expect(response.status).toBe(200)
    const { url } = (await response.json()) as { url: string }
    return new URL(url)
  }

  it('signs in with a host-only secure cookie on the workspace host', async () => {
    const response = await signIn(fixture.acmeSlug)
    const cookies = response.headers.getSetCookie()
    expect(cookies.some((cookie) => cookie.startsWith('__Secure-better-auth.session_token='))).toBe(
      true,
    )
    for (const cookie of cookies) {
      expect(cookie).not.toMatch(/;\s*domain=/i)
      expect(cookie).toMatch(/;\s*secure/i)
      expect(cookie).toMatch(/;\s*httponly/i)
    }
  })

  it('moves a member to another workspace host with a single-use code', async () => {
    const cookie = sessionCookie(await signIn(fixture.acmeSlug))
    const url = await issuedCode(cookie, fixture.northwind)
    expect(url.origin).toBe(origin(fixture.northwindSlug))
    expect(url.pathname).toBe('/auth/handoff')
    const code = url.searchParams.get('code') ?? ''
    expect(Buffer.from(code, 'base64url')).toHaveLength(32)

    const stored = await fixture.admin.query<{ code_hash: string; ttl: number }>(
      `select code_hash, extract(epoch from expires_at - created_at)::int as ttl
      from identity_workspace.workspace_handoff where user_id = $1`,
      [fixture.userId],
    )
    expect(stored.rows.map((row) => row.code_hash)).toContain(
      createHash('sha256').update(code).digest('hex'),
    )
    expect(stored.rows.some((row) => row.code_hash === code)).toBe(false)
    expect(stored.rows.every((row) => row.ttl === 60)).toBe(true)

    const exchanged = await post('/workspace-handoff/exchange', { code }, url.origin)
    expect(exchanged.status).toBe(200)
    for (const setCookie of exchanged.headers.getSetCookie())
      expect(setCookie).not.toMatch(/;\s*domain=/i)
    const session = await auth.api.getSession({
      headers: new Headers({ Cookie: sessionCookie(exchanged) }),
    })
    expect(session?.user.id).toBe(fixture.userId)

    const reused = await post('/workspace-handoff/exchange', { code }, url.origin)
    expect(reused.status).toBe(400)
    expect(await reused.json()).toMatchObject({ code: 'WORKSPACE_HANDOFF_INVALID' })
    expect(reused.headers.getSetCookie()).toEqual([])
  })

  it('never issues a code for a workspace the user does not belong to', async () => {
    const cookie = sessionCookie(await signIn(fixture.acmeSlug))
    const response = await issue(cookie, fixture.globex)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
    expect(
      (
        await post(
          '/workspace-handoff/issue',
          { workspaceId: fixture.northwind },
          origin(fixture.acmeSlug),
        )
      ).status,
    ).toBe(401)
  })

  it('burns a code presented on another host', async () => {
    const cookie = sessionCookie(await signIn(fixture.acmeSlug))
    const code = (await issuedCode(cookie, fixture.northwind)).searchParams.get('code')
    const wrongHost = await post('/workspace-handoff/exchange', { code }, origin(fixture.acmeSlug))
    expect(wrongHost.status).toBe(400)
    expect(wrongHost.headers.getSetCookie()).toEqual([])
    for (const from of ['https://example.com', 'https://www.example.com', 'https://evil.test']) {
      const rejected = await post('/workspace-handoff/exchange', { code }, from)
      expect(rejected.status).toBeGreaterThanOrEqual(400)
      expect(rejected.headers.getSetCookie()).toEqual([])
    }
    const late = await post('/workspace-handoff/exchange', { code }, origin(fixture.northwindSlug))
    expect(late.status).toBe(400)
  })

  it('rejects an expired code', async () => {
    const cookie = sessionCookie(await signIn(fixture.acmeSlug))
    const code = (await issuedCode(cookie, fixture.northwind)).searchParams.get('code') ?? ''
    await fixture.admin.query(
      `update identity_workspace.workspace_handoff set expires_at = now() - interval '1 second'
      where code_hash = $1`,
      [createHash('sha256').update(code).digest('hex')],
    )
    const expired = await post(
      '/workspace-handoff/exchange',
      { code },
      origin(fixture.northwindSlug),
    )
    expect(expired.status).toBe(400)
    expect(expired.headers.getSetCookie()).toEqual([])
  })

  it('rate limits code exchange attempts per client', async () => {
    const ip = testClientIp()
    const statuses: number[] = []
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await post(
        '/workspace-handoff/exchange',
        { code: 'A'.repeat(43) },
        origin(fixture.northwindSlug),
        undefined,
        ip,
      )
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
  })
})
