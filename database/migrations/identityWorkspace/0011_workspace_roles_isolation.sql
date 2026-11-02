ALTER TABLE identity_workspace.workspace_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_workspace.workspace_role FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Members read the custom roles of their own workspaces, which is how capabilities are resolved.
-- There are no write policies: custom roles are modeled but not managed by the runtime yet, so only
-- the migration owner can create them. Repeat the runtime grants after this migration.
CREATE POLICY workspace_role_visible ON identity_workspace.workspace_role FOR SELECT
USING (EXISTS (
  SELECT 1 FROM identity_workspace.member m
  WHERE m.organization_id = workspace_role.organization_id
    AND m.user_id = nullif(current_setting('mailflow.user_id', true), '')
));
