import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

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
        { table_schema: 'identity_workspace', table_name: 'rate_limit' },
        { table_schema: 'identity_workspace', table_name: 'session' },
        { table_schema: 'identity_workspace', table_name: 'user' },
        { table_schema: 'identity_workspace', table_name: 'verification' },
        { table_schema: 'mail', table_name: 'message' },
      ])
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
        "INSERT INTO mail.message (sender_name, subject, body, received_at) VALUES ('Migration test', 'Preserved', 'Existing data', now())",
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
