import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLabelRepository } from './repository.js'

const databaseUrl =
  process.env.MAILFLOW_MAIL_INTEGRATION_DATABASE_URL ??
  'postgresql://mailflow:mailflow@localhost:5432/mailflow'
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname))
  throw new Error('Tests require local PostgreSQL')

describe('label repository', () => {
  const name = `labels_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  let pool: Pool
  let owner: Pool
  const role = `label_app_${randomUUID().replaceAll('-', '')}`
  let repo: ReturnType<typeof createLabelRepository>
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`)
    const url = new URL(databaseUrl)
    url.pathname = `/${name}`
    owner = new Pool({ connectionString: url.href })
    await migrate(drizzle(owner), {
      migrationsFolder: './database/migrations/mail',
      migrationsSchema: 'mail_migrations',
      migrationsTable: '__drizzle_migrations',
    })
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'local_only' NOSUPERUSER NOBYPASSRLS`)
    await owner.query(
      `GRANT USAGE ON SCHEMA mail TO "${role}"; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mail TO "${role}"`,
    )
    url.username = role
    url.password = 'local_only'
    pool = new Pool({ connectionString: url.href })
    repo = createLabelRepository(pool)
  })
  afterAll(async () => {
    await pool?.end()
    await owner?.end()
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
    await admin.query(`DROP ROLE IF EXISTS "${role}"`)
    await admin.end()
  })
  it('paginates in total order and detects exact matches outside the page', async () => {
    for (const value of ['Alpha', 'Alphabet', 'Alpine', 'Also', 'Alt', 'Alto'])
      await repo.createLabel('a', value)
    const page = await repo.searchLabels('a', 'al', null)
    expect(page.items).toHaveLength(5)
    expect(page.nextCursor).not.toBeNull()
    expect((await repo.searchLabels('a', 'al', page.nextCursor)).items.map((v) => v.name)).toEqual([
      'Alto',
    ])
    for (const value of ['a-needle', 'b-needle', 'c-needle', 'd-needle', 'e-needle', 'needle'])
      await repo.createLabel('a', value)
    const exact = await repo.searchLabels('a', 'NEEDLE', null)
    expect(exact.items).toHaveLength(5)
    expect(exact.items.some((item) => item.name === 'needle')).toBe(false)
    expect(exact.exactMatch?.name).toBe('needle')
    expect((await repo.searchLabels('b', '', null)).items).toEqual([])
  })
  it('allocates distinct colors before reusing the palette, including concurrent creates', async () => {
    const labels = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repo.createLabel('color-workspace', `Label ${index}`),
      ),
    )
    expect(labels.every(Boolean)).toBe(true)
    expect(new Set(labels.map((label) => label?.color)).size).toBe(8)
  })
  it('prevents concurrent duplicate names within each workspace', async () => {
    const result = await Promise.all([
      repo.createLabel('a', 'Concurrent'),
      repo.createLabel('a', 'CONCURRENT'),
    ])
    expect(result.filter(Boolean)).toHaveLength(1)
    expect(await repo.createLabel('b', 'Concurrent')).not.toBeNull()
  })
  it('enforces workspace and sent ownership for message associations', async () => {
    const message = randomUUID()
    const sent = randomUUID()
    await owner.query(
      "insert into mail.message (workspace_id,id,sender_name,subject,body,received_at) values ('a',$1,'sender','subject','body',now())",
      [message],
    )
    await owner.query(
      "insert into mail.outgoing_email (workspace_id,user_id,id,payload_hash,\"to\",cc,bcc,subject,html,text,delivery_state,provider_id) values ('a','owner',$1,'hash','[]','[]','[]','subject','','','sent','provider')",
      [sent],
    )
    const label = await repo.createLabel('a', 'Association')
    if (!label) throw new Error('missing label')
    expect(
      await repo.changeMessageLabel('a', 'owner', 'messages', message, label.id, true),
    ).toEqual([label])
    expect(await repo.changeMessageLabel('a', 'owner', 'sent', sent, label.id, true)).toEqual([
      label,
    ])
    expect(await repo.messageLabels('a', 'other', 'sent', sent)).toBeNull()
    expect(await repo.messageLabels('b', 'owner', 'messages', message)).toBeNull()
    expect(await repo.changeMessageLabel('b', 'owner', 'sent', sent, label.id, true)).toBeNull()
    expect(await repo.changeMessageLabel('a', 'owner', 'sent', sent, label.id, false)).toEqual([])
  })
})
