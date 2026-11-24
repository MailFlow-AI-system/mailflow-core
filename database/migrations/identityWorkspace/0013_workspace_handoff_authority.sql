ALTER TABLE identity_workspace.workspace_handoff ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_workspace.workspace_handoff FORCE ROW LEVEL SECURITY;
-- No policies: the runtime role can neither read nor write handoff rows directly.
--> statement-breakpoint
-- Issues a one-time code for a workspace the actor belongs to. The code itself never reaches
-- the database; only its SHA-256 is stored. Lifetime is fixed here so callers cannot widen it.
-- Selecting the workspace also records it as the actor's preference.
CREATE FUNCTION identity_workspace.issue_workspace_handoff(target text, code_hash text)
RETURNS TABLE(slug text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
  actor text := nullif(current_setting('mailflow.user_id', true), '');
  target_slug text;
BEGIN
  IF actor IS NULL OR target IS NULL OR length(target) > 128
    OR code_hash IS NULL OR code_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  SELECT s.slug INTO target_slug FROM identity_workspace.select_workspace_preference(target) s;
  IF target_slug IS NULL THEN RETURN; END IF;
  DELETE FROM identity_workspace.workspace_handoff h
    WHERE h.user_id = actor AND h.expires_at < now() - interval '1 hour';
  INSERT INTO identity_workspace.workspace_handoff(code_hash, user_id, workspace_id, expires_at)
    VALUES (issue_workspace_handoff.code_hash, actor, target, now() + interval '60 seconds');
  RETURN QUERY SELECT target_slug;
END;
$$;
REVOKE ALL ON FUNCTION identity_workspace.issue_workspace_handoff(text, text) FROM PUBLIC;
--> statement-breakpoint
-- Consumes a code atomically. The row is marked used before any other check, so a code that
-- is presented on the wrong host, after expiry or after membership revocation is burned.
CREATE FUNCTION identity_workspace.consume_workspace_handoff(code_hash text, host_slug text)
RETURNS TABLE(user_id text, workspace_id text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
  grant_user text;
  grant_workspace text;
  grant_expires timestamptz;
BEGIN
  IF code_hash IS NULL OR code_hash !~ '^[0-9a-f]{64}$' OR host_slug IS NULL THEN RETURN; END IF;
  UPDATE identity_workspace.workspace_handoff h SET consumed_at = now()
    WHERE h.code_hash = consume_workspace_handoff.code_hash AND h.consumed_at IS NULL
    RETURNING h.user_id, h.workspace_id, h.expires_at
    INTO grant_user, grant_workspace, grant_expires;
  IF NOT FOUND OR grant_expires <= now() THEN RETURN; END IF;
  PERFORM m.id FROM identity_workspace.member m
    JOIN identity_workspace.organization o ON o.id = m.organization_id
    WHERE m.user_id = grant_user AND m.organization_id = grant_workspace AND o.slug = host_slug
    FOR SHARE OF m;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT grant_user, grant_workspace;
END;
$$;
REVOKE ALL ON FUNCTION identity_workspace.consume_workspace_handoff(text, text) FROM PUBLIC;
-- Deployment gate: grant EXECUTE on both functions only to the reviewed restricted runtime role.
