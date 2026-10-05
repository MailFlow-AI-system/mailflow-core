ALTER TABLE identity_workspace.organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_workspace.organization FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_workspace.member ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_workspace.member FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_workspace.invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_workspace.invitation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_self_membership ON identity_workspace.member FOR SELECT
USING (user_id = nullif(current_setting('mailflow.user_id', true), ''));
CREATE POLICY workspace_discovery ON identity_workspace.organization FOR SELECT
USING (EXISTS (
  SELECT 1 FROM identity_workspace.member m
  WHERE m.organization_id = organization.id
    AND m.user_id = nullif(current_setting('mailflow.user_id', true), '')
));
--> statement-breakpoint
-- No mutation policies in discovery: provisioning requires its own reviewed authority.
-- The invariant function must be owned by the privileged migration role, never the app.
CREATE FUNCTION identity_workspace.require_workspace_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE target text; targets text[];
BEGIN
  IF TG_TABLE_NAME = 'organization' THEN
    targets := ARRAY[NEW.id];
  ELSE
    IF TG_OP = 'INSERT' THEN targets := ARRAY[NEW.organization_id];
    ELSIF TG_OP = 'DELETE' THEN targets := ARRAY[OLD.organization_id];
    ELSE targets := ARRAY[OLD.organization_id, NEW.organization_id];
    END IF;
  END IF;
  FOREACH target IN ARRAY targets LOOP
    PERFORM 1 FROM identity_workspace.organization WHERE id = target FOR UPDATE;
    IF FOUND AND (SELECT count(*) FROM identity_workspace.member
                  WHERE organization_id = target AND role = 'owner') <> 1 THEN
      RAISE EXCEPTION 'workspace requires exactly one owner' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION identity_workspace.require_workspace_owner() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER workspace_requires_owner
AFTER INSERT OR UPDATE ON identity_workspace.organization
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION identity_workspace.require_workspace_owner();
CREATE CONSTRAINT TRIGGER membership_requires_owner
AFTER INSERT OR UPDATE OR DELETE ON identity_workspace.member
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION identity_workspace.require_workspace_owner();
