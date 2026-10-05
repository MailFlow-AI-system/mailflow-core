-- Receipt authorization exists before the canonical entities, but cannot survive
-- commit without both foreign keys. Only a fresh generated pair can be provisioned.
ALTER TABLE identity_workspace.onboarding_signup
  ALTER CONSTRAINT onboarding_signup_user_id_user_id_fk DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE identity_workspace.onboarding_signup
  ALTER CONSTRAINT onboarding_signup_organization_id_organization_id_fk DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE identity_workspace.onboarding_signup ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_workspace.onboarding_signup FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_workspace.onboarding_email ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_workspace.onboarding_email FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY onboarding_receipt_read ON identity_workspace.onboarding_signup FOR SELECT
USING (key_hash = nullif(current_setting('mailflow.onboarding_key', true), ''));
CREATE POLICY onboarding_receipt_insert ON identity_workspace.onboarding_signup FOR INSERT
WITH CHECK (
  key_hash = nullif(current_setting('mailflow.onboarding_key', true), '')
  AND user_id = nullif(current_setting('mailflow.user_id', true), '')
  AND organization_id = nullif(current_setting('mailflow.onboarding_workspace', true), '')
);
--> statement-breakpoint
CREATE POLICY onboarding_workspace_read ON identity_workspace.organization FOR SELECT
USING (EXISTS (
  SELECT 1 FROM identity_workspace.onboarding_signup s
  WHERE s.organization_id = organization.id
    AND s.user_id = nullif(current_setting('mailflow.user_id', true), '')
));
CREATE POLICY onboarding_workspace_insert ON identity_workspace.organization FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM identity_workspace.onboarding_signup s
  WHERE s.organization_id = organization.id
    AND s.user_id = nullif(current_setting('mailflow.user_id', true), '')
));
CREATE POLICY onboarding_owner_insert ON identity_workspace.member FOR INSERT
WITH CHECK (
  role = 'owner'
  AND user_id = nullif(current_setting('mailflow.user_id', true), '')
  AND EXISTS (
    SELECT 1 FROM identity_workspace.onboarding_signup s
    WHERE s.organization_id = member.organization_id AND s.user_id = member.user_id
  )
);
--> statement-breakpoint
-- Enqueue authority is identity-specific. There is deliberately no read/update
-- policy for dispatch yet, and no onboarding permission to mutate other tenants.
CREATE POLICY onboarding_email_enqueue ON identity_workspace.onboarding_email FOR INSERT
WITH CHECK (
  user_id = nullif(current_setting('mailflow.user_id', true), '')
  AND state = 'pending' AND attempts = 0 AND payload LIKE 'v1.%'
  AND lease_token IS NULL AND lease_until IS NULL
);
