ALTER TABLE identity_workspace.workspace_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_workspace.workspace_preference FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_preference_self ON identity_workspace.workspace_preference FOR SELECT
USING (user_id = nullif(current_setting('mailflow.user_id', true), ''));
--> statement-breakpoint
-- Only this bounded function may write preferences. Its privileged migration
-- owner must bypass FORCE RLS; the runtime role must not own it or bypass RLS.
-- Membership row locks prevent concurrent revocation before the write commits.
CREATE FUNCTION identity_workspace.select_workspace_preference(target text)
RETURNS TABLE(id text, name text, slug text, role text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE actor text := nullif(current_setting('mailflow.user_id', true), '');
BEGIN
  IF actor IS NULL OR target IS NULL OR length(target) > 128 THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace-preference:' || actor, 0));
  PERFORM m.id FROM identity_workspace.member m
    WHERE m.user_id = actor AND m.organization_id = target FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM o.id FROM identity_workspace.organization o WHERE o.id = target FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO identity_workspace.workspace_preference(user_id, workspace_id, updated_at)
    VALUES (actor, target, now())
    ON CONFLICT (user_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, updated_at = now();
  RETURN QUERY SELECT o.id, o.name, o.slug, m.role
    FROM identity_workspace.organization o JOIN identity_workspace.member m ON m.organization_id = o.id
    WHERE o.id = target AND m.user_id = actor;
END;
$$;
REVOKE ALL ON FUNCTION identity_workspace.select_workspace_preference(text) FROM PUBLIC;
-- Deployment gate: grant EXECUTE only to the reviewed restricted runtime role.
