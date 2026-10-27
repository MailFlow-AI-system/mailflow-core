import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createSampleWorkspace, createVerifiedUser } from './provisionWorkspace.js'

const url = new URL(
  process.env.DIRECT_URL ?? 'postgresql://mailflow:mailflow@localhost:5432/mailflow',
)
if (process.env.APP_ENV && process.env.APP_ENV !== 'development')
  throw new Error('Workspace sample requires development')
if (!['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('Workspace sample requires the disposable local PostgreSQL instance')
const pool = new Pool({ connectionString: url.href })
const suffix = randomUUID().slice(0, 8)
const email = `local-${suffix}@mailflow.invalid`
const password = `Local-${randomUUID()}`
const slug = `acme-${suffix}`
const workspaceId = randomUUID()
try {
  const user = await createVerifiedUser(pool, { name: 'Local User', email, password })
  await createSampleWorkspace(pool, { id: workspaceId, name: 'Acme Local', slug, ownerId: user.id })
  console.info(
    JSON.stringify(
      { host: `http://${slug}.localhost:3000`, email, password, workspaceId },
      null,
      2,
    ),
  )
} finally {
  await pool.end()
}
