import { randomInt, randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { drizzle } from 'drizzle-orm/node-postgres'
import pino from 'pino'
import { createApp } from '../../src/app.js'
import { createIdentityWorkspaceRuntime } from '../../src/modules/identityWorkspace/index.js'
import { createOnboardingDispatcher } from '../../src/modules/identityWorkspace/onboarding/dispatcher.js'
import type { IdentityRow } from '../../src/modules/identityWorkspace/onboarding/types.js'
import { createOnboardingCipher } from '../../src/modules/identityWorkspace/onboarding/utils/cipher.js'
import { createWorkspaceTestFixture } from '../../src/modules/identityWorkspace/workspaces/fixtures.test-support.js'
import { loadConfig } from '../../src/shared/config/env.js'
import type { BrowserSignupScenario, CapturedOnboardingEmail } from './types.js'

const fixture = await createWorkspaceTestFixture()
const scenarios: BrowserSignupScenario[] = ['Desktop Chrome', 'Mobile Chrome'].map(
  (project, index) => ({
    project,
    email: `onboarding-browser-${randomUUID()}@mailflow.invalid`,
    slug: `browser-${index}-${randomUUID().slice(0, 8)}`,
    name: `Browser ${index} Workspace`,
  }),
)
const config = {
  ...fixture.authConfig,
  baseURL: 'http://127.0.0.1:8082',
  siteURL: 'http://localhost:4329',
  webAppURL: 'http://workspace.test:3001',
  allowedOrigins: [
    'http://localhost:4329',
    'http://workspace.test:3001',
    ...scenarios.map((scenario) => `http://${scenario.slug}.workspace.test:3001`),
  ],
}
const cipher = createOnboardingCipher(config.secret)
const clientIps = new Map(
  config.allowedOrigins.map((origin) => {
    const suffix = randomInt(65536)
    return [origin, `198.18.${suffix >>> 8}.${suffix & 255}`]
  }),
)
function withFixtureClientIp(request: Request) {
  const headers = new Headers(request.headers)
  const ip = clientIps.get(headers.get('Origin') ?? '')
  if (ip) headers.set('x-real-ip', ip)
  return new Request(request, { headers })
}
const captured = new Map<string, CapturedOnboardingEmail[]>()
const dispatch = createOnboardingDispatcher({
  pool: fixture.pool,
  cipher,
  send: async (message) => {
    const messages = captured.get(message.to) ?? []
    messages.push(message)
    captured.set(message.to, messages)
  },
})
const runtime = await createIdentityWorkspaceRuntime({
  pool: fixture.pool,
  database: drizzle(fixture.pool),
  authConfig: config,
  sendAccountEmail: async () => {},
  environment: {
    APP_ENV: 'development',
    WORKSPACE_READ_ENABLED: 'true',
    WORKSPACE_ONBOARDING_ENABLED: 'true',
    WORKSPACE_SIGNUP_CUTOVER_ENABLED: 'true',
    WORKSPACE_WEB_BASE_ORIGIN: config.webAppURL,
  },
})
const auth = runtime.auth
const onboarding = runtime.onboarding
if (!onboarding) throw new Error('Onboarding fixture capabilities are required')
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
  auth: { api: auth.api, handler: (request) => auth.handler(withFixtureClientIp(request)) },
  onboarding: {
    ...onboarding,
    handleOtp: (request) => onboarding.handleOtp(withFixtureClientIp(request)),
  },
})
// Loopback-only synthetic test capabilities. Never compiled into production.
app.get('/__fixture', (context) => context.json({ scenarios }))
app.post('/__delivery', async (context) => {
  const { email } = await context.req.json()
  if (!scenarios.some((scenario) => scenario.email === email))
    return context.json({ error: 'Unknown fixture' }, 400)
  const jobs = await fixture.admin.query<IdentityRow>(
    `select e.id from identity_workspace.onboarding_email e join identity_workspace."user" u on u.id = e.user_id where u.email = $1 and e.state = 'pending' order by e.created_at`,
    [email],
  )
  for (const job of jobs.rows) await dispatch(job.id)
  return context.json({ messages: captured.get(email) ?? [] })
})
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 8082 })
console.info('Onboarding browser fixture ready on loopback:8082; no external email delivery')
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    server.close(() => {
      void (async () => {
        try {
          const emails = scenarios.map((scenario) => scenario.email)
          await fixture.admin.query(
            'delete from identity_workspace.organization where id in (select organization_id from identity_workspace.member where user_id in (select id from identity_workspace."user" where email = any($1::text[])))',
            [emails],
          )
          await fixture.admin.query(
            'delete from identity_workspace."user" where email = any($1::text[])',
            [emails],
          )
          await fixture.admin.query(
            'delete from identity_workspace.verification where identifier = any($1::text[])',
            [emails.map((email) => `email-verification-otp-${email}`)],
          )
        } finally {
          await fixture.close()
        }
      })().then(() => process.exit(0))
    })
  })
