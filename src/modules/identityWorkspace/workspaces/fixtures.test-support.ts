import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { loadAuthConfig } from '../infrastructure/auth/authConfig.js'
import { createAuth } from '../infrastructure/auth/createAuth.js'
import { workspaceTestDatabaseUrl } from './testDatabase.test-support.js'

export async function createWorkspaceTestFixture() {
  const value = workspaceTestDatabaseUrl()
  const url = new URL(value)
  const admin = new Pool({ connectionString: value, max: 3 })
  const migrationLock = await admin.connect()
  try {
    await migrationLock.query('select pg_advisory_lock(77193022)')
    await migrate(drizzle(admin), {
      migrationsFolder: './database/migrations/identityWorkspace',
      migrationsSchema: 'identity_workspace_migrations',
      migrationsTable: '__drizzle_migrations',
    })
    await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workspace_test_app') THEN
      CREATE ROLE workspace_test_app LOGIN PASSWORD 'workspace_app_local_only' NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$;
  GRANT USAGE ON SCHEMA identity_workspace TO workspace_test_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity_workspace TO workspace_test_app;
  GRANT EXECUTE ON FUNCTION identity_workspace.select_workspace_preference(text) TO workspace_test_app;`)
  } finally {
    try {
      await migrationLock.query('select pg_advisory_unlock(77193022)')
    } finally {
      migrationLock.release()
    }
  }
  url.username = 'workspace_test_app'
  url.password = 'workspace_app_local_only'
  const pool = new Pool({ connectionString: url.href, max: 2, statement_timeout: 2000 })
  const slugSuffix = randomUUID().slice(0, 8)
  const authConfig = loadAuthConfig({
    APP_ENV: 'development',
    BETTER_AUTH_SECRET: 'workspace-functional-test-secret-0123456789',
    BETTER_AUTH_URL: 'http://127.0.0.1:8081',
    SITE_URL: 'http://localhost:4321',
    WEB_APP_URL: `http://acme-${slugSuffix}.workspace.test:3001`,
    RESEND_API_KEY: 'no-external-delivery',
    RESEND_FROM_EMAIL: 'noreply@mailflow.invalid',
  })
  const auth = createAuth(drizzle(pool), authConfig, async () => {})
  const email = `workspace-${randomUUID()}@mailflow.invalid`,
    password = 'workspace-fixture-password-123'
  const user = await auth.api.signUpEmail({ body: { name: 'Workspace Test', email, password } })
  await admin.query('update identity_workspace."user" set email_verified = true where id = $1', [
    user.user.id,
  ])
  const otherEmail = `other-${randomUUID()}@mailflow.invalid`
  const otherUser = await auth.api.signUpEmail({
    body: { name: 'Other User', email: otherEmail, password },
  })
  const otherId = otherUser.user.id
  await admin.query('update identity_workspace."user" set email_verified=true where id=$1', [
    otherId,
  ])
  const acme = randomUUID(),
    northwind = randomUUID(),
    globex = randomUUID()
  const client = await admin.connect()
  try {
    await client.query('BEGIN')
    for (const [id, name, slug, owner] of [
      [acme, 'Acme Corp', `acme-${slugSuffix}`, user.user.id],
      [northwind, 'Northwind', `northwind-${slugSuffix}`, otherId],
      [globex, 'Globex', `globex-${slugSuffix}`, otherId],
    ]) {
      await client.query(
        `insert into identity_workspace.organization(id, name, slug, created_at) values ($1,$2,$3,now())`,
        [id, name, slug],
      )
      await client.query(
        `insert into identity_workspace.member(id, organization_id, user_id, role, created_at) values ($1,$2,$3,'owner',now())`,
        [randomUUID(), id, owner],
      )
    }
    await client.query(
      `insert into identity_workspace.member(id, organization_id, user_id, role, created_at) values ($1,$2,$3,'member',now())`,
      [randomUUID(), northwind, user.user.id],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return {
    admin,
    pool,
    auth,
    authConfig,
    email,
    password,
    userId: user.user.id,
    otherId,
    otherEmail,
    acme,
    northwind,
    globex,
    acmeSlug: `acme-${slugSuffix}`,
    northwindSlug: `northwind-${slugSuffix}`,
    globexSlug: `globex-${slugSuffix}`,
    close: async () => {
      try {
        await admin.query(
          'delete from identity_workspace.organization where id = any($1::text[])',
          [[acme, northwind, globex]],
        )
        await admin.query('delete from identity_workspace."user" where id = any($1::text[])', [
          [user.user.id, otherId],
        ])
        await admin.query(
          'delete from identity_workspace.verification where identifier = any($1::text[])',
          [[`email-verification-otp-${email}`, `email-verification-otp-${otherEmail}`]],
        )
        await admin.query('delete from identity_workspace.rate_limit where key = any($1::text[])', [
          [`workspace-discovery:${user.user.id}`, `workspace-discovery:${otherId}`],
        ])
      } finally {
        await pool.end()
        await admin.end()
      }
    },
  }
}
