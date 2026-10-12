import { serve } from '@hono/node-server'
import { drizzle } from 'drizzle-orm/node-postgres'
import pino from 'pino'
import { createApp } from '../../src/app.js'
import { createIdentityWorkspaceRuntime } from '../../src/modules/identityWorkspace/index.js'
import { createWorkspaceTestFixture } from '../../src/modules/identityWorkspace/workspaces/fixtures.test-support.js'
import { loadConfig } from '../../src/shared/config/env.js'

const fixture = await createWorkspaceTestFixture()
const runtime = await createIdentityWorkspaceRuntime({
  environment: { WORKSPACE_READ_ENABLED: 'true' },
  pool: fixture.pool,
  database: drizzle(fixture.pool),
  authConfig: fixture.authConfig,
  sendAccountEmail: async () => {},
})
const app = createApp({
  ...runtime,
  config: loadConfig({
    DATABASE_URL: process.env.MAILFLOW_WORKSPACE_TEST_DATABASE_URL,
    LOG_LEVEL: 'silent',
  }),
  logger: pino({ enabled: false }),
  checkDatabase: async () => {
    await fixture.pool.query('select 1')
  },
})
// Bound to loopback and excluded from production: synthetic fixtures only, not a product API.
app.get('/__fixture', (context) =>
  context.json({
    host: `${fixture.acmeSlug}.workspace.test`,
    globexHost: `${fixture.globexSlug}.workspace.test`,
    email: fixture.email,
    password: fixture.password,
  }),
)
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 8081 })
console.info('Workspace browser fixture ready on 127.0.0.1:8081')
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    server.close(() => {
      void fixture.close().then(() => process.exit(0))
    })
  })
