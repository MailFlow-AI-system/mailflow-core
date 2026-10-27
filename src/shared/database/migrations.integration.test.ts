import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { readMigrationFiles } from 'drizzle-orm/migrator'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runMigrations } from './migrations.js'

// Use only a disposable PostgreSQL instance: this suite creates and drops its own databases.
const testUrl = process.env.MAILFLOW_MIGRATIONS_TEST_DATABASE_URL
const describeIntegration = testUrl ? describe : describe.skip

describeIntegration('PostgreSQL migrations', { timeout: 30_000 }, () => {
  const admin = new Client({ connectionString: testUrl ?? 'postgresql://localhost/invalid' })
  const databases: string[] = []

  beforeAll(async () => {
    await admin.connect()
  }, 30_000)

  afterAll(async () => {
    try {
      for (const name of databases) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
    } finally {
      await admin.end()
    }
  }, 30_000)

  async function createTestDatabase() {
    const name = `migrations_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${name}"`)
    databases.push(name)
    const url = new URL(testUrl ?? '')
    url.pathname = `/${name}`
    return { DIRECT_URL: url.toString() }
  }

  async function connect(environment: { DIRECT_URL: string }) {
    const client = new Client({ connectionString: environment.DIRECT_URL })
    await client.connect()
    return client
  }

  async function ledger(client: Client, schema: string) {
    const result = await client.query<{ hash: string; created_at: string }>(
      `SELECT hash, created_at FROM "${schema}".__drizzle_migrations ORDER BY created_at`,
    )
    return result.rows
  }

  function expectedLedger(folder: string) {
    return readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL(`../../../database/migrations/${folder}/`, import.meta.url),
      ),
    }).map((migration) => ({ hash: migration.hash, created_at: String(migration.folderMillis) }))
  }

  it('installs both modules on an empty database and preserves journals in both ledgers', async () => {
    const environment = await createTestDatabase()
    await runMigrations(environment)
    const client = await connect(environment)
    try {
      expect(await ledger(client, 'identity_workspace_migrations')).toEqual(
        expectedLedger('identityWorkspace'),
      )
      expect(await ledger(client, 'mail_migrations')).toEqual(expectedLedger('mail'))
      const tables = await client.query(
        "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('identity_workspace', 'mail') ORDER BY table_schema, table_name",
      )
      expect(tables.rows).toEqual([
        { table_schema: 'identity_workspace', table_name: 'account' },
        { table_schema: 'identity_workspace', table_name: 'invitation' },
        { table_schema: 'identity_workspace', table_name: 'member' },
        { table_schema: 'identity_workspace', table_name: 'onboarding_email' },
        { table_schema: 'identity_workspace', table_name: 'onboarding_signup' },
        { table_schema: 'identity_workspace', table_name: 'organization' },
        { table_schema: 'identity_workspace', table_name: 'rate_limit' },
        { table_schema: 'identity_workspace', table_name: 'session' },
        { table_schema: 'identity_workspace', table_name: 'user' },
        { table_schema: 'identity_workspace', table_name: 'verification' },
        { table_schema: 'identity_workspace', table_name: 'workspace_preference' },
        { table_schema: 'mail', table_name: 'attachment' },
        { table_schema: 'mail', table_name: 'message' },
        { table_schema: 'mail', table_name: 'outgoing_email' },
        { table_schema: 'mail', table_name: 'outgoing_email_attachment' },
      ])
    } finally {
      await client.end()
    }
  })

  it('preserves verified final objects while removing antivirus metadata', async () => {
    const environment = await createTestDatabase()
    const client = await connect(environment)
    try {
      const previous = readMigrationFiles({
        migrationsFolder: fileURLToPath(
          new URL('../../../database/migrations/mail/', import.meta.url),
        ),
      }).slice(0, 4)
      await client.query('CREATE SCHEMA mail_migrations')
      await client.query(
        'CREATE TABLE mail_migrations.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)',
      )
      for (const migration of previous) {
        for (const statement of migration.sql) await client.query(statement)
        await client.query(
          'INSERT INTO mail_migrations.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
          [migration.hash, migration.folderMillis],
        )
      }
      const legacyId = randomUUID()
      await client.query(
        `INSERT INTO mail.attachment
         (user_id, id, filename, content_type, size, sha256, status, temporary_key, final_key, scan_version, scanned_at)
         VALUES ('migration-owner', $1, 'legacy.txt', 'text/plain', 0, $2, 'clean', 'pending/legacy', 'objects/legacy', 'legacy', now())`,
        [legacyId, 'b'.repeat(64)],
      )
      await runMigrations(environment, ['mail'])
      expect(
        (
          await client.query('SELECT status, final_key FROM mail.attachment WHERE id = $1', [
            legacyId,
          ])
        ).rows,
      ).toEqual([{ status: 'clean', final_key: 'objects/legacy' }])
      const id = randomUUID()
      await client.query(
        `INSERT INTO mail.attachment
         (workspace_id, user_id, id, filename, content_type, size, sha256, status, temporary_key, final_key)
         VALUES ('migration-workspace', 'migration-owner', $1, 'empty.txt', 'text/plain', 0, $2, 'clean', 'pending/test', 'objects/test')`,
        [id, 'a'.repeat(64)],
      )
      const columns = (
        await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = 'mail' AND table_name = 'attachment'",
        )
      ).rows.map(({ column_name }) => column_name)
      expect(columns).not.toContain('scan_version')
      expect(columns).not.toContain('scanned_at')
      expect(await ledger(client, 'mail_migrations')).toEqual(expectedLedger('mail'))
    } finally {
      await client.end()
    }
  })

  it('preserves unmapped legacy Mail rows and rejects new unscoped writes without changing listings', async () => {
    const environment = await createTestDatabase()
    const client = await connect(environment)
    try {
      const previous = readMigrationFiles({
        migrationsFolder: fileURLToPath(
          new URL('../../../database/migrations/mail/', import.meta.url),
        ),
      }).slice(0, 5)
      await client.query('CREATE SCHEMA mail_migrations')
      await client.query(
        'CREATE TABLE mail_migrations.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)',
      )
      for (const migration of previous) {
        for (const statement of migration.sql) await client.query(statement)
        await client.query(
          'INSERT INTO mail_migrations.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
          [migration.hash, migration.folderMillis],
        )
      }
      const id = randomUUID()
      await client.query(
        `INSERT INTO mail.outgoing_email(user_id,id,payload_hash,"to",cc,bcc,subject,html,text,provider_id,sent_at)
        VALUES ('legacy-owner',$1,'legacy','["ada@example.test"]','[]','[]','Legacy','Legacy','Legacy','provider',now())`,
        [id],
      )
      await client.query(
        `INSERT INTO mail.attachment(user_id,id,filename,content_type,size,sha256,status,temporary_key,expires_at)
        VALUES ('legacy-owner',$1,'legacy.txt','text/plain',0,repeat('a',64),'pending','pending/legacy',now()-interval '1 day')`,
        [id],
      )
      await runMigrations(environment, ['mail'])
      const { drizzle } = await import('drizzle-orm/node-postgres')
      const { createOutgoingRepository } = await import(
        '../../modules/mail/infrastructure/database/outgoingRepository.js'
      )
      const { createAttachmentRepository } = await import(
        '../../modules/mail/infrastructure/database/attachmentRepository.js'
      )
      const database = drizzle({ client })
      expect(await createOutgoingRepository(database).listSent('legacy-owner', 0)).toContainEqual(
        expect.objectContaining({ id, subject: 'Legacy' }),
      )
      expect(
        (
          await client.query(
            'SELECT workspace_id, delivery_key FROM mail.outgoing_email WHERE id=$1',
            [id],
          )
        ).rows,
      ).toEqual([{ workspace_id: null, delivery_key: null }])
      const repository = createAttachmentRepository(database)
      expect(
        await repository.get({ userId: 'legacy-owner', workspaceId: 'unrelated' }, id),
      ).toBeNull()
      expect(await repository.claimExpired(100, 'cleanup')).toEqual([])
      await expect(
        client.query('UPDATE mail.outgoing_email SET subject=subject WHERE id=$1', [id]),
      ).rejects.toThrow('outgoing_email_workspace_required')
      await expect(
        client.query(
          `INSERT INTO mail.attachment(user_id,id,filename,content_type,size,sha256,status,temporary_key)
        VALUES ('new-owner',$1,'new.txt','text/plain',0,repeat('a',64),'pending','pending/new')`,
          [randomUUID()],
        ),
      ).rejects.toThrow('attachment_workspace_required')
      expect(
        (
          await client.query(
            "SELECT convalidated FROM pg_constraint WHERE conname IN ('attachment_workspace_required','outgoing_attachment_workspace_required','outgoing_email_workspace_required')",
          )
        ).rows,
      ).toEqual([{ convalidated: false }, { convalidated: false }, { convalidated: false }])
    } finally {
      await client.end()
    }
  })

  async function installMailPrefix(client: Client, length: number) {
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL('../../../database/migrations/mail/', import.meta.url),
      ),
    }).slice(0, length)
    await client.query('CREATE SCHEMA mail_migrations')
    await client.query(
      'CREATE TABLE mail_migrations.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)',
    )
    for (const migration of migrations) {
      for (const statement of migration.sql) if (statement.trim()) await client.query(statement)
      await client.query(
        'INSERT INTO mail_migrations.__drizzle_migrations (hash, created_at) VALUES ($1,$2)',
        [migration.hash, migration.folderMillis],
      )
    }
  }

  it('reconciles the applied Send history without deleting or inventing workspace ownership for legacy Inbox data', async () => {
    const environment = await createTestDatabase()
    const client = await connect(environment)
    try {
      await installMailPrefix(client, 6)
      const id = randomUUID()
      await client.query(
        "INSERT INTO mail.message(id,sender_name,subject,body,received_at) VALUES ($1,'Legacy sender','Preserved Inbox','Original content',now())",
        [id],
      )
      await runMigrations(environment, ['mail'])
      expect(
        (await client.query('SELECT id,workspace_id,subject,body FROM mail.message')).rows,
      ).toEqual([{ id, workspace_id: null, subject: 'Preserved Inbox', body: 'Original content' }])
      expect(
        (
          await client.query(
            "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='mail.message'::regclass",
          )
        ).rows,
      ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
      expect(
        (
          await client.query(
            "SELECT convalidated FROM pg_constraint WHERE conname='message_workspace_required'",
          )
        ).rows,
      ).toEqual([{ convalidated: false }])
      await expect(
        client.query(
          "INSERT INTO mail.message(sender_name,subject,body,received_at) VALUES ('New','Unscoped','Rejected',now())",
        ),
      ).rejects.toThrow('message_workspace_required')
      expect(await ledger(client, 'mail_migrations')).toEqual(expectedLedger('mail'))
    } finally {
      await client.end()
    }
  })

  it('reconciles PR24-only history, applies older missing Send migrations and preserves existing workspace messages', async () => {
    const environment = await createTestDatabase()
    const client = await connect(environment)
    try {
      await installMailPrefix(client, 1)
      const legacySql = readFileSync(
        new URL(
          '../../../database/migrations/mail/legacy/0001_workspace_inbox.sql',
          import.meta.url,
        ),
        'utf8',
      )
      for (const statement of legacySql.split('--> statement-breakpoint'))
        if (statement.trim()) await client.query(statement)
      const legacyRow = {
        hash: createHash('sha256').update(legacySql).digest('hex'),
        created_at: '1793025084417',
      }
      await client.query(
        'INSERT INTO mail_migrations.__drizzle_migrations(hash,created_at) VALUES ($1,$2)',
        [legacyRow.hash, legacyRow.created_at],
      )
      const id = randomUUID()
      await client.query(
        "INSERT INTO mail.message(id,workspace_id,sender_name,subject,body,received_at) VALUES ($1,'actual-workspace','Sender','Preserved scoped Inbox','Original scoped content',now())",
        [id],
      )
      await runMigrations(environment, ['mail'])
      expect((await client.query('SELECT id,workspace_id,subject FROM mail.message')).rows).toEqual(
        [{ id, workspace_id: 'actual-workspace', subject: 'Preserved scoped Inbox' }],
      )
      expect(
        (
          await client.query(
            "SELECT is_nullable FROM information_schema.columns WHERE table_schema='mail' AND table_name='message' AND column_name='workspace_id'",
          )
        ).rows,
      ).toEqual([{ is_nullable: 'YES' }])
      const expected = [...expectedLedger('mail'), legacyRow].sort(
        (a, b) => Number(a.created_at) - Number(b.created_at),
      )
      expect(await ledger(client, 'mail_migrations')).toEqual(expected)
      expect(
        (await client.query("SELECT to_regclass('mail.outgoing_email') AS outgoing")).rows,
      ).toEqual([{ outgoing: 'mail.outgoing_email' }])
      await runMigrations(environment, ['mail'])
      expect(await ledger(client, 'mail_migrations')).toEqual(expected)
    } finally {
      await client.end()
    }
  })

  it('preserves outgoing data when PR24 was applied after the older Send migrations', async () => {
    const environment = await createTestDatabase()
    const client = await connect(environment)
    try {
      await installMailPrefix(client, 3)
      const outgoingId = randomUUID()
      await client.query(
        `INSERT INTO mail.outgoing_email(id,user_id,payload_hash,"to",cc,bcc,subject,html,text,provider_id,sent_at) VALUES ($1,'legacy-owner','original-hash','["recipient@example.test"]','[]','[]','Preserved outgoing','<p>Original</p>','Original','accepted-provider',now())`,
        [outgoingId],
      )
      const legacySql = readFileSync(
        new URL(
          '../../../database/migrations/mail/legacy/0001_workspace_inbox.sql',
          import.meta.url,
        ),
        'utf8',
      )
      for (const statement of legacySql.split('--> statement-breakpoint'))
        if (statement.trim()) await client.query(statement)
      await client.query(
        'INSERT INTO mail_migrations.__drizzle_migrations(hash,created_at) VALUES ($1,$2)',
        [createHash('sha256').update(legacySql).digest('hex'), '1793025084417'],
      )
      await runMigrations(environment, ['mail'])
      expect(
        (
          await client.query(
            'SELECT id,user_id,workspace_id,payload_hash,provider_id,delivery_state FROM mail.outgoing_email',
          )
        ).rows,
      ).toEqual([
        {
          id: outgoingId,
          user_id: 'legacy-owner',
          workspace_id: null,
          payload_hash: 'original-hash',
          provider_id: 'accepted-provider',
          delivery_state: 'uncertain',
        },
      ])
    } finally {
      await client.end()
    }
  })

  it('blocks an unknown applied Mail migration before creating Identity or modifying existing data', async () => {
    const environment = await createTestDatabase()
    const client = await connect(environment)
    try {
      await installMailPrefix(client, 1)
      await client.query(
        "INSERT INTO mail_migrations.__drizzle_migrations(hash,created_at) VALUES ('unknown-history',1795000000000)",
      )
      await expect(runMigrations(environment)).rejects.toThrow('Migration ledger mismatch for mail')
      expect(
        (await client.query("SELECT to_regnamespace('identity_workspace') AS schema")).rows,
      ).toEqual([{ schema: null }])
      expect(
        (
          await client.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='mail' AND table_name='message' AND column_name='workspace_id'",
          )
        ).rows,
      ).toEqual([])
    } finally {
      await client.end()
    }
  })

  it('makes the real pre-deploy entrypoint exit nonzero on divergence without changing application data', async () => {
    const environment = await createTestDatabase()
    const client = await connect(environment)
    try {
      await installMailPrefix(client, 6)
      await client.query(
        "UPDATE mail_migrations.__drizzle_migrations SET hash='tampered' WHERE created_at=1793016657678",
      )
      await expect(
        promisify(execFile)(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(new URL('../../entrypoints/migrate.ts', import.meta.url)),
          ],
          {
            env: { ...process.env, ...environment },
            cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('MIGRATION_LEDGER_MISMATCH'),
      })
      expect(
        (await client.query("SELECT to_regnamespace('identity_workspace') AS schema")).rows,
      ).toEqual([{ schema: null }])
      expect(
        (
          await client.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='mail' AND table_name='message' AND column_name='workspace_id'",
          )
        ).rows,
      ).toEqual([])
    } finally {
      await client.end()
    }
  })

  it('repeats without duplicating ledger entries or changing existing data', async () => {
    const environment = await createTestDatabase()
    await runMigrations(environment)
    const client = await connect(environment)
    try {
      await client.query(
        "INSERT INTO mail.message (workspace_id, sender_name, subject, body, received_at) VALUES ('workspace-migration-test', 'Migration test', 'Preserved', 'Existing data', now())",
      )
      const before = await ledger(client, 'identity_workspace_migrations')
      await runMigrations(environment)
      expect(await ledger(client, 'identity_workspace_migrations')).toEqual(before)
      expect(await ledger(client, 'mail_migrations')).toEqual(expectedLedger('mail'))
      expect((await client.query('SELECT subject FROM mail.message')).rows).toEqual([
        { subject: 'Preserved' },
      ])
    } finally {
      await client.end()
    }
  })

  it('upgrades a database with the original identity migration already applied', async () => {
    const environment = await createTestDatabase()
    const client = await connect(environment)
    try {
      const first = readMigrationFiles({
        migrationsFolder: fileURLToPath(
          new URL('../../../database/migrations/identityWorkspace/', import.meta.url),
        ),
      })[0]
      if (!first) throw new Error('Missing initial identity migration')
      await client.query('CREATE SCHEMA identity_workspace_migrations')
      await client.query(
        'CREATE TABLE identity_workspace_migrations.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)',
      )
      await client.query('BEGIN')
      for (const statement of first.sql) await client.query(statement)
      await client.query(
        'INSERT INTO identity_workspace_migrations.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
        [first.hash, first.folderMillis],
      )
      await client.query('COMMIT')
      await runMigrations(environment)
      expect(await ledger(client, 'identity_workspace_migrations')).toEqual(
        expectedLedger('identityWorkspace'),
      )
      expect(await ledger(client, 'mail_migrations')).toEqual(expectedLedger('mail'))
    } finally {
      await client.end()
    }
  })

  it('adds recipient names to existing outgoing mail without changing legacy data', async () => {
    const environment = await createTestDatabase()
    const client = await connect(environment)
    try {
      const previous = readMigrationFiles({
        migrationsFolder: fileURLToPath(
          new URL('../../../database/migrations/mail/', import.meta.url),
        ),
      }).slice(0, 2)
      await client.query('CREATE SCHEMA mail_migrations')
      await client.query(
        'CREATE TABLE mail_migrations.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)',
      )
      for (const migration of previous) {
        for (const statement of migration.sql) await client.query(statement)
        await client.query(
          'INSERT INTO mail_migrations.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
          [migration.hash, migration.folderMillis],
        )
      }
      await client.query(`INSERT INTO mail.outgoing_email (id, user_id, payload_hash, "to", cc, bcc, subject, html, text)
        VALUES ('00000000-0000-4000-8000-000000000001', 'owner', 'legacy-hash', '["ada@example.test"]', '[]', '[]', 'Legacy', '<p>Hello</p>', 'Hello')`)
      await runMigrations(environment, ['mail'])
      expect(
        (
          await client.query(
            'SELECT recipient_name, payload_hash, subject FROM mail.outgoing_email',
          )
        ).rows,
      ).toEqual([{ recipient_name: '', payload_hash: 'legacy-hash', subject: 'Legacy' }])
      expect(await ledger(client, 'mail_migrations')).toEqual(expectedLedger('mail'))
    } finally {
      await client.end()
    }
  })

  it('rolls back a failed module, releases the session lock, and resumes after the failure is resolved', async () => {
    const environment = await createTestDatabase()
    const client = await connect(environment)
    try {
      await client.query(`CREATE FUNCTION reject_mail_index() RETURNS event_trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_TAG = 'CREATE INDEX' AND current_query() LIKE '%"mail"%' THEN
            RAISE EXCEPTION 'Injected Mail migration failure';
          END IF;
        END $$`)
      await client.query(
        'CREATE EVENT TRIGGER reject_mail_index ON ddl_command_end EXECUTE FUNCTION reject_mail_index()',
      )
      await expect(runMigrations(environment)).rejects.toThrow()
      expect(await ledger(client, 'identity_workspace_migrations')).toEqual(
        expectedLedger('identityWorkspace'),
      )
      expect(await ledger(client, 'mail_migrations')).toEqual([])
      expect((await client.query("SELECT to_regnamespace('mail') AS schema")).rows).toEqual([
        { schema: null },
      ])
      expect(
        (await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [1_296_450_119])).rows,
      ).toEqual([{ acquired: true }])
      await client.query('SELECT pg_advisory_unlock($1)', [1_296_450_119])
      await client.query('DROP EVENT TRIGGER reject_mail_index')
      await runMigrations(environment)
      expect(await ledger(client, 'identity_workspace_migrations')).toEqual(
        expectedLedger('identityWorkspace'),
      )
      expect(await ledger(client, 'mail_migrations')).toEqual(expectedLedger('mail'))
    } finally {
      await client.end()
    }
  })

  it('serializes concurrent invocations before either one reads or applies migrations', async () => {
    const environment = await createTestDatabase()
    const blocker = await connect(environment)
    await blocker.query('SELECT pg_advisory_lock($1)', [1_296_450_119])
    const runs = Promise.all([runMigrations(environment), runMigrations(environment)])
    try {
      let waiting = 0
      for (let attempt = 0; attempt < 40; attempt++) {
        const result = await blocker.query<{ count: string }>(
          "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'mailflow-core-migrations' AND wait_event = 'advisory'",
        )
        waiting = Number(result.rows[0]?.count)
        if (waiting === 2) break
        await delay(50)
      }
      expect(waiting).toBe(2)
      expect(
        (await blocker.query("SELECT to_regnamespace('identity_workspace_migrations') AS schema"))
          .rows,
      ).toEqual([{ schema: null }])
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1)', [1_296_450_119])
      await runs
      await blocker.end()
    }
    const client = await connect(environment)
    try {
      expect(await ledger(client, 'identity_workspace_migrations')).toEqual(
        expectedLedger('identityWorkspace'),
      )
      expect(await ledger(client, 'mail_migrations')).toEqual(expectedLedger('mail'))
    } finally {
      await client.end()
    }
  })

  it('uses DIRECT_URL rather than an unreachable DATABASE_URL', async () => {
    const environment = await createTestDatabase()
    await runMigrations(
      { ...environment, DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/invalid' },
      ['mail'],
    )
    const client = await connect(environment)
    try {
      expect(await ledger(client, 'mail_migrations')).toEqual(expectedLedger('mail'))
      expect(
        (await client.query("SELECT to_regnamespace('identity_workspace') AS schema")).rows,
      ).toEqual([{ schema: null }])
    } finally {
      await client.end()
    }
  })
})
