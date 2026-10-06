import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { drizzle } from 'drizzle-orm/node-postgres'
import pino from 'pino'
import { createApp } from '../../src/app.js'
import {
  assertWorkspaceDatabaseRole,
  assertWorkspaceSelectionDatabaseRole,
  createAuth,
  createDiscoveryBudget,
  createWorkspaceEntryReader,
  createWorkspaceReader,
  createWorkspaceSelection,
} from '../../src/modules/identityWorkspace/index.js'
import { testClientIp } from '../../src/modules/identityWorkspace/onboarding/utils/testClientIp.test-support.js'
import { createWorkspaceTestFixture } from '../../src/modules/identityWorkspace/workspaces/fixtures.test-support.js'
import { loadConfig } from '../../src/shared/config/env.js'

const fixture = await createWorkspaceTestFixture()
await assertWorkspaceDatabaseRole(fixture.pool)
await assertWorkspaceSelectionDatabaseRole(fixture.pool)
const port = 3003
const host = `${fixture.acmeSlug}.workspace.test`
const targetHost = `${fixture.northwindSlug}.workspace.test`
const controlKey = randomUUID()
const authConfig = {
  ...fixture.authConfig,
  baseURL: 'http://127.0.0.1:8083',
  webAppURL: `http://${host}:${port}`,
  allowedOrigins: [
    fixture.authConfig.siteURL,
    `http://${host}:${port}`,
    `http://${targetHost}:${port}`,
    `http://workspace.test:${port}`,
  ],
}
const auth = createAuth(drizzle(fixture.pool), authConfig, async () => {}, undefined, {
  localWorkspaceCookie: true,
})
let clientIp = testClientIp()
const selection = createWorkspaceSelection(fixture.pool)
const entryReader = createWorkspaceEntryReader(fixture.pool)
let failNextEntry = false
const emptyEmail = `empty-${randomUUID()}@mailflow.invalid`
const emptyUser = await auth.api.signUpEmail({
  body: { name: 'No Workspace', email: emptyEmail, password: fixture.password },
})
await fixture.admin.query('update identity_workspace."user" set email_verified=true where id=$1', [
  emptyUser.user.id,
])
let selections = 0
let failNext = false
let revokeAfterSelection = false
let globalMailCalls = 0
const app = createApp({
  config: loadConfig({
    DATABASE_URL: process.env.MAILFLOW_WORKSPACE_TEST_DATABASE_URL,
    LOG_LEVEL: 'silent',
  }),
  logger: pino({ enabled: false }),
  checkDatabase: async () => {
    await fixture.pool.query('select 1')
  },
  auth: {
    api: auth.api,
    // Simulate a trusted proxy assigning each isolated browser test its own IP.
    // Keep Better Auth rate limiting enabled; never trust a browser-supplied IP.
    handler: (request) => {
      const headers = new Headers(request.headers)
      headers.set('x-real-ip', clientIp)
      return auth.handler(new Request(request, { headers }))
    },
  },
  allowedAuthOrigins: authConfig.allowedOrigins,
  workspaces: {
    reader: createWorkspaceReader(fixture.pool),
    consumeBudget: createDiscoveryBudget(fixture.pool),
  },
  workspaceEntry: {
    reader: {
      resolve: async (actor) => {
        if (failNextEntry) {
          failNextEntry = false
          throw new Error('Synthetic entry failure')
        }
        return entryReader.resolve(actor)
      },
    },
    consumeBudget: createDiscoveryBudget(fixture.pool),
  },
  workspaceSelection: {
    allowedOrigins: authConfig.allowedOrigins,
    consumeBudget: createDiscoveryBudget(fixture.pool),
    selection: {
      select: async (actor, target) => {
        selections += 1
        if (failNext) {
          failNext = false
          throw new Error('Synthetic selection failure')
        }
        const result = await selection.select(actor, target)
        if (result && revokeAfterSelection) {
          revokeAfterSelection = false
          await fixture.admin.query(
            'delete from identity_workspace.member where user_id=$1 and organization_id=$2',
            [fixture.userId, fixture.northwind],
          )
        }
        return result
      },
    },
  },
  mailRepository: {
    findMessages: async () => {
      globalMailCalls += 1
      throw new Error('Global mail must never be loaded')
    },
  },
})
// This server is loopback-only, requires the isolated test DB, and is not built/deployed.
app.get('/__fixture', async (context) => {
  const preference = await fixture.admin.query(
    'select workspace_id from identity_workspace.workspace_preference where user_id=$1',
    [fixture.userId],
  )
  const activeOrganization = await fixture.admin.query(
    'select exists(select 1 from identity_workspace.session where user_id=$1 and active_organization_id is not null) as active',
    [fixture.userId],
  )
  return context.json({
    host,
    targetHost,
    email: fixture.email,
    otherEmail: fixture.otherEmail,
    emptyEmail,
    password: fixture.password,
    targetId: fixture.northwind,
    currentId: fixture.acme,
    fallbackHost: `${[fixture.acme, fixture.northwind].sort()[0] === fixture.acme ? fixture.acmeSlug : fixture.northwindSlug}.workspace.test`,
    unrelatedId: fixture.globex,
    unrelatedHost: `${fixture.globexSlug}.workspace.test`,
    controlKey,
    selections,
    globalMailCalls,
    preference: preference.rows[0]?.workspace_id ?? null,
    hasActiveOrganization: activeOrganization.rows[0].active,
  })
})
app.post('/__fixture/control', async (context) => {
  if (context.req.header('x-fixture-control') !== controlKey)
    return context.json({ error: 'Forbidden' }, 403)
  const { action } = await context.req.json()
  if (action === 'reset') {
    clientIp = testClientIp()
    await fixture.admin.query(
      'delete from identity_workspace.workspace_preference where user_id=any($1::text[])',
      [[fixture.userId, fixture.otherId, emptyUser.user.id]],
    )
    await fixture.admin.query(
      'delete from identity_workspace.rate_limit where key=any($1::text[])',
      [
        [fixture.userId, fixture.otherId, emptyUser.user.id].map(
          (id) => `workspace-discovery:${id}`,
        ),
      ],
    )
    await fixture.admin.query(
      "insert into identity_workspace.member(id,organization_id,user_id,role,created_at) values($1,$2,$3,'member',now()) on conflict(organization_id,user_id) do nothing",
      [randomUUID(), fixture.northwind, fixture.userId],
    )
    selections = 0
    failNext = false
    revokeAfterSelection = false
    failNextEntry = false
  } else if (action === 'fail-next') failNext = true
  else if (action === 'fail-next-entry') failNextEntry = true
  else if (action === 'expire-session')
    await fixture.admin.query('delete from identity_workspace.session where user_id=$1', [
      fixture.userId,
    ])
  else if (action === 'revoke-after-selection') revokeAfterSelection = true
  else if (action === 'revoke-northwind')
    await fixture.admin.query(
      'delete from identity_workspace.member where user_id=$1 and organization_id=$2',
      [fixture.userId, fixture.northwind],
    )
  else return context.json({ error: 'Invalid action' }, 400)
  return context.json({ ready: true })
})
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 8083 })
console.info('Workspace switching fixture ready on 127.0.0.1:8083')
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    server.close(() => {
      void (async () => {
        await fixture.admin.query('delete from identity_workspace."user" where id=$1', [
          emptyUser.user.id,
        ])
        await fixture.admin.query(
          'delete from identity_workspace.verification where identifier=$1',
          [`email-verification-otp-${emptyEmail}`],
        )
        await fixture.admin.query('delete from identity_workspace.rate_limit where key=$1', [
          `workspace-discovery:${emptyUser.user.id}`,
        ])
        await fixture.close()
        process.exit(0)
      })()
    })
  })
