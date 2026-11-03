import { Hono } from 'hono'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { capabilities } from '#modules/identityWorkspace'
import { createApp } from '../../../app.js'
import {
  findMailCapabilityRule,
  mailCapabilityPolicy,
  requireMailCapability,
} from './capabilityPolicy.js'

describe('mail capability policy', () => {
  it.each([
    ['GET', '/api/v1/mail/context', null],
    ['GET', '/api/v1/mail/sent', 'mail.read'],
    ['GET', '/api/v1/mail/sent/0198f0a8-0000-7000-8000-000000000001', 'mail.read'],
    ['GET', '/api/v1/mail/attachments/att-1', 'mail.read'],
    ['GET', '/api/v1/mail/attachments/att-1/inline', 'mail.read'],
    ['GET', '/api/v1/mail/attachments/att-1/download', 'mail.read'],
    ['GET', '/api/v1/workspaces/acme/mail/messages', 'mail.read'],
    [
      'GET',
      '/api/v1/workspaces/acme/mail/messages/0198f0a8-0000-7000-8000-000000000001',
      'mail.read',
    ],
    ['POST', '/api/v1/mail/send', 'mail.compose'],
    ['POST', '/api/v1/mail/discard', 'mail.compose'],
    ['POST', '/api/v1/mail/attachments', 'mail.compose'],
    ['POST', '/api/v1/mail/attachments/att-1/complete', 'mail.compose'],
    ['GET', '/api/v1/workspaces/acme/mail/labels', 'mail.read'],
    ['GET', '/api/v1/workspaces/acme/mail/labels/palette', 'mail.read'],
    ['GET', '/api/v1/workspaces/acme/mail/messages/m1/labels', 'mail.read'],
    ['GET', '/api/v1/workspaces/acme/mail/sent/m1/labels', 'mail.read'],
    ['POST', '/api/v1/workspaces/acme/mail/labels', 'mail.compose'],
    ['PUT', '/api/v1/workspaces/acme/mail/messages/m1/labels/l1', 'mail.compose'],
    ['DELETE', '/api/v1/workspaces/acme/mail/sent/m1/labels/l1', 'mail.compose'],
  ] as const)('maps %s %s to %s', (method, path, capability) => {
    expect(findMailCapabilityRule(method, path)?.capability).toBe(capability)
  })

  it.each([
    ['DELETE', '/api/v1/mail/sent'],
    ['PUT', '/api/v1/mail/send'],
    ['POST', '/api/v1/mail/sent'],
    ['GET', '/api/v1/mail/send'],
    ['GET', '/api/v1/mail/unknown'],
    ['GET', '/api/v1/workspaces/acme/mail/unknown'],
    ['GET', '/api/v1/mail/attachments/att-1/complete'],
    ['GET', '/api/v1/mail/sent/a/b'],
  ])('has no rule for %s %s', (method, path) => {
    expect(findMailCapabilityRule(method, path)).toBeUndefined()
  })

  it('only names capabilities that exist in the catalog', () => {
    for (const rule of mailCapabilityPolicy) {
      if (rule.capability) expect(capabilities).toContain(rule.capability)
    }
  })
})

function guarded(granted?: readonly string[]) {
  const app = new Hono()
  app.use('*', async (context, next) => {
    if (granted) context.set('mailCapabilities', granted)
    await next()
  })
  app.use('*', requireMailCapability)
  app.all('*', (context) => context.text('reached'))
  return app
}

describe('requireMailCapability', () => {
  it('lets a request through when the capability is granted', async () => {
    const response = await guarded(['mail.read']).request('/api/v1/mail/sent')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('reached')
  })

  it('denies with Problem Details when the capability is missing', async () => {
    const response = await guarded(['mail.read']).request('/api/v1/mail/send', { method: 'POST' })
    expect(response.status).toBe(403)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(await response.json()).toMatchObject({ code: 'insufficient_capability', status: 403 })
  })

  it('only needs membership for routes without a capability', async () => {
    expect((await guarded([]).request('/api/v1/mail/context')).status).toBe(200)
  })

  it('denies when no capabilities were resolved at all', async () => {
    expect((await guarded().request('/api/v1/mail/sent')).status).toBe(403)
    expect((await guarded().request('/api/v1/mail/send', { method: 'POST' })).status).toBe(403)
  })

  it('denies a route without a policy entry even for a role with every capability', async () => {
    const response = await guarded([...capabilities]).request('/api/v1/mail/not-listed')
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'insufficient_capability' })
  })
})

describe('policy coverage of the real routes', () => {
  it('lists every mail route that the application registers', () => {
    const app = createApp({
      config: {
        appEnv: 'development',
        databaseUrl: 'postgresql://localhost/test',
        host: 'localhost',
        port: 8080,
        logLevel: 'silent',
        apiDocsEnabled: false,
        serviceVersion: 'test',
        otlpEndpoint: undefined,
        otelTraceSampleRate: 0,
        serviceInstanceId: 'test',
      },
      logger: pino({ enabled: false }),
      checkDatabase: async () => {},
      auth: { handler: async () => new Response(), api: { getSession: async () => null } },
      allowedAuthOrigins: ['https://mail.example.test'],
      mailRepository: { findMessages: vi.fn() } as never,
      workspaces: { reader: {} as never, consumeBudget: vi.fn() },
      attachments: {} as never,
      labels: {} as never,
      outgoingMail: { repository: {}, deliver: vi.fn(), resolveAttachments: vi.fn() } as never,
    })
    const mailRoutes = app.routes.filter(
      (route) =>
        route.method !== 'ALL' &&
        /^\/api\/v1\/(?:mail|workspaces\/:slug\/mail)(?:\/|$)/.test(route.path),
    )

    expect(mailRoutes.length).toBeGreaterThanOrEqual(15)
    const unlisted = mailRoutes
      .filter(
        (route) => !findMailCapabilityRule(route.method, route.path.replaceAll(/:[A-Za-z]+/g, 'x')),
      )
      .map((route) => `${route.method} ${route.path}`)
    expect(unlisted).toEqual([])
  })
})
