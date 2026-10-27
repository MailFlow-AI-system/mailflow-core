-- Review and run only after the deployment pipeline has applied the current migrations.
-- This proposal deliberately creates no usable login or password.
BEGIN;
SELECT workspace_id FROM mail.message LIMIT 0;
SELECT delivery_state, attempt_token FROM mail.outgoing_email LIMIT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mailflow_runtime') THEN
    CREATE ROLE mailflow_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
      NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mailflow_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
    RAISE EXCEPTION 'Existing mailflow_runtime role has unsafe privileges';
  END IF;
END $$;
GRANT USAGE ON SCHEMA identity_workspace, mail TO mailflow_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity_workspace, mail TO mailflow_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA identity_workspace, mail TO mailflow_runtime;
GRANT EXECUTE ON FUNCTION identity_workspace.select_workspace_preference(text) TO mailflow_runtime;
-- Repeat the grants after future migrations; do not grant membership in the schema-owner role.
COMMIT;
