import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createApp } from '../../src/app.js'
import { createIdentityWorkspaceRuntime } from '../../src/modules/identityWorkspace/index.js'
import { testClientIp } from '../../src/modules/identityWorkspace/onboarding/utils/testClientIp.test-support.js'
import { createWorkspaceTestFixture } from '../../src/modules/identityWorkspace/workspaces/fixtures.test-support.js'
import type { DiscoveryBudget } from '../../src/modules/identityWorkspace/workspaces/types.js'
import {
  assertMailDatabaseRole,
  createAttachmentRepository,
  createAttachmentService,
  createMailMessageRepository,
  createOutgoingRepository,
} from '../../src/modules/mail/index.js'
import { inWorkspaceTransaction } from '../../src/modules/mail/infrastructure/database/workspaceTransaction.js'
import { seedMail } from '../../src/modules/mail/seed/seedMail.js'
import { createFixtureObjectStorage } from './objectStorage.js'
import { createTelemetryFixture } from './telemetryFixture.js'

const fixture = await createWorkspaceTestFixture()
await migrate(drizzle(fixture.admin), {
  migrationsFolder: './database/migrations/mail',
  migrationsSchema: 'mail_migrations',
  migrationsTable: '__drizzle_migrations',
})
await fixture.admin.query(
  'GRANT USAGE ON SCHEMA mail TO workspace_test_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mail TO workspace_test_app',
)
await assertMailDatabaseRole(fixture.pool)
for (const [workspaceId, name] of [
  [fixture.acme, 'Acme'],
  [fixture.northwind, 'Northwind'],
] as const) {
  await seedMail(fixture.pool, workspaceId)
  await inWorkspaceTransaction(fixture.pool, workspaceId, (client) =>
    client.query(
      'INSERT INTO mail.message(id,workspace_id,sender_name,subject,body,received_at) VALUES($1,$2,$3,$4,$5,now())',
      [
        randomUUID(),
        workspaceId,
        `${name} Sender`,
        `${name} private message`,
        `Confidential ${name} content`,
      ],
    ),
  )
}
const fixtureOutgoing = createOutgoingRepository(drizzle(fixture.admin))
async function resetSent() {
  await fixture.admin.query('DELETE FROM mail.outgoing_email WHERE user_id=ANY($1::text[])', [
    [fixture.userId, fixture.otherId],
  ])
  for (const [workspaceId, userId, label, count] of [
    [fixture.acme, fixture.userId, 'Acme', 21],
    [fixture.northwind, fixture.userId, 'Northwind', 2],
    [fixture.northwind, fixture.otherId, 'Foreign Northwind', 1],
  ] as const) {
    for (let index = 1; index <= count; index++) {
      const id = randomUUID()
      const context = { workspaceId, userId }
      await fixtureOutgoing.reserve({
        ...context,
        id,
        payloadHash: `fixture-${id}`,
        deliveryKey: `fixture-${id}`,
        to: ['recipient@example.test'],
        cc: [],
        bcc: [],
        recipientName: `${label} recipient`,
        subject: `${label} sent message ${String(index).padStart(2, '0')}`,
        html: `<p>${label} private sent content</p>`,
        text: `${label} private sent content`,
        attachments: [],
      })
      await fixtureOutgoing.markSent(context, id, `fixture-provider-${id}`)
    }
  }
}
await resetSent()
const port = 3003
const baseHost = process.env.MAILFLOW_WORKSPACE_TEST_BASE_HOST ?? 'workspace.test'
const host = `${fixture.acmeSlug}.${baseHost}`
const targetHost = `${fixture.northwindSlug}.${baseHost}`
const controlKey = randomUUID()
const authConfig = {
  ...fixture.authConfig,
  baseURL: 'http://127.0.0.1:8083',
  webAppURL: `http://${host}:${port}`,
  allowedOrigins: [
    fixture.authConfig.siteURL,
    `http://${host}:${port}`,
    `http://${targetHost}:${port}`,
    `http://${baseHost}:${port}`,
  ],
}
const runtime = await createIdentityWorkspaceRuntime({
  pool: fixture.pool,
  database: drizzle(fixture.pool),
  authConfig,
  sendAccountEmail: async () => {},
  environment: {
    APP_ENV: 'development',
    WORKSPACE_READ_ENABLED: 'true',
    WORKSPACE_LOCAL_SWITCHING_ENABLED: 'true',
  },
})
const auth = runtime.auth
let clientIp = testClientIp()
const selection = runtime.workspaceSelection?.selection
const entryReader = runtime.workspaceEntry?.reader
if (!selection || !entryReader || !runtime.workspaces)
  throw new Error('Workspace fixture capabilities are required')
let failNextEntry = false
const emptyEmail = `empty-${randomUUID()}@mailflow.invalid`
const emptyUser = await fixture.auth.api.signUpEmail({
  body: { name: 'No Workspace', email: emptyEmail, password: fixture.password },
})
await fixture.admin.query('update identity_workspace."user" set email_verified=true where id=$1', [
  emptyUser.user.id,
])
let selections = 0
let failNext = false
let revokeAfterSelection = false
const globalMailCalls = 0
let failNextBudget = false
const budget = runtime.workspaces.consumeBudget
const consumeBudget: DiscoveryBudget = async (actor) => {
  if (failNextBudget) {
    failNextBudget = false
    throw new Error('Synthetic budget outage')
  }
  return budget(actor)
}
const telemetry = await createTelemetryFixture()
const objectFixture = createFixtureObjectStorage('http://127.0.0.1:8083')
const attachments = createAttachmentService({
  repository: createAttachmentRepository(drizzle(fixture.pool)),
  storage: objectFixture.storage,
})
const app = createApp({
  ...runtime,
  config: telemetry.config,
  logger: telemetry.logger,
  observability: telemetry.observability,
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
  workspaces: {
    reader: runtime.workspaces.reader,
    consumeBudget,
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
    consumeBudget,
  },
  workspaceSelection: {
    allowedOrigins: authConfig.allowedOrigins,
    consumeBudget,
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
  mailRepository: createMailMessageRepository(fixture.pool),
  mailWorkspaceBaseOrigin: `http://${baseHost}:3003`,
  attachments,
  outgoingMail: {
    resolveAttachments: attachments.resolveReferences,
    repository: createOutgoingRepository(drizzle(fixture.pool)),
    // Keep browser acceptance inside the isolated fixture; never call an external provider.
    deliver: async (message) => `fixture-provider-${message.id}`,
  },
})
app.all('/__fixture/uploads/:token', async (context) => {
  const origin = context.req.header('origin') ?? ''
  if (!runtime.isAllowedAuthOrigin?.(origin)) return context.body(null, 403)
  context.header('Access-Control-Allow-Origin', origin)
  context.header('Vary', 'Origin')
  context.header('Access-Control-Allow-Methods', 'PUT')
  // The fixture shares Core's origin, where Faro legitimately propagates trace headers.
  context.header('Access-Control-Allow-Headers', 'content-type,traceparent,tracestate')
  if (context.req.method === 'OPTIONS') return context.body(null, 204)
  const response = await objectFixture.upload(context.req.raw)
  response.headers.set('Access-Control-Allow-Origin', origin)
  response.headers.set('Vary', 'Origin')
  return response
})
// This server is loopback-only, requires the isolated test DB, and is not built/deployed.
app.get('/__telemetry', (context) => {
  if (context.req.header('x-fixture-control') !== controlKey)
    return context.json({ error: 'Forbidden' }, 403)
  return context.json(telemetry.snapshot())
})
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
    fallbackHost: `${[fixture.acme, fixture.northwind].sort()[0] === fixture.acme ? fixture.acmeSlug : fixture.northwindSlug}.${baseHost}`,
    unrelatedId: fixture.globex,
    unrelatedHost: `${fixture.globexSlug}.${baseHost}`,
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
    failNextBudget = false
  } else if (action === 'reset-sent') await resetSent()
  else if (action === 'fail-next') failNext = true
  else if (action === 'fail-next-entry') failNextEntry = true
  else if (action === 'fail-next-budget') failNextBudget = true
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
        await telemetry.observability.shutdown()
        await fixture.admin.query('DELETE FROM mail.outgoing_email WHERE user_id=ANY($1::text[])', [
          [fixture.userId, fixture.otherId],
        ])
        await fixture.admin.query('DELETE FROM mail.attachment WHERE user_id=ANY($1::text[])', [
          [fixture.userId, fixture.otherId],
        ])
        await fixture.admin.query('DELETE FROM mail.message WHERE workspace_id=ANY($1::text[])', [
          [fixture.acme, fixture.northwind],
        ])
        await fixture.close()
        process.exit(0)
      })()
    })
  })
