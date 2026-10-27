import { Pool } from 'pg'

const url = new URL(
  process.env.DIRECT_URL ?? 'postgresql://mailflow:mailflow@localhost:5432/mailflow',
)
if (process.env.APP_ENV && process.env.APP_ENV !== 'development')
  throw new Error('Local database setup requires development')
if (!['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('Local database setup requires the disposable local PostgreSQL instance')
const pool = new Pool({ connectionString: url.href })
try {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mailflow_app') THEN
      CREATE ROLE mailflow_app LOGIN PASSWORD 'mailflow_app_local_only' NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$;
  GRANT USAGE ON SCHEMA identity_workspace, mail TO mailflow_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity_workspace TO mailflow_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON mail.message TO mailflow_app;
  GRANT EXECUTE ON FUNCTION identity_workspace.select_workspace_preference(text) TO mailflow_app;`)
  console.info(
    'Local mailflow_app grants applied. Use DATABASE_URL with mailflow_app; keep DIRECT_URL on mailflow.',
  )
} finally {
  await pool.end()
}
