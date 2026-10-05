import { serve } from '@hono/node-server'
import pino from 'pino'
import { createApp } from '../../src/app.js'
import {
  assertWorkspaceDatabaseRole,
  createDiscoveryBudget,
  createWorkspaceReader,
} from '../../src/modules/identityWorkspace/index.js'
import { createWorkspaceTestFixture } from '../../src/modules/identityWorkspace/workspaces/fixtures.test-support.js'
import { loadConfig } from '../../src/shared/config/env.js'

const fixture = await createWorkspaceTestFixture()
await assertWorkspaceDatabaseRole(fixture.pool)
const app = createApp({
  config: loadConfig({
    DATABASE_URL: process.env.MAILFLOW_WORKSPACE_TEST_DATABASE_URL,
    LOG_LEVEL: 'silent',
  }),
  logger: pino({ enabled: false }),
  checkDatabase: async () => {
    await fixture.pool.query('select 1')
  },
  auth: fixture.auth,
  allowedAuthOrigins: fixture.authConfig.allowedOrigins,
  workspaces: {
    reader: createWorkspaceReader(fixture.pool),
    consumeBudget: createDiscoveryBudget(fixture.pool),
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
