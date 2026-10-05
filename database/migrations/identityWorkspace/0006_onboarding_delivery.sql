-- This server-only capability applies exclusively to the Identity-owned delivery
-- table. It grants no read or mutation authority on Organization or Membership.
CREATE POLICY onboarding_email_dispatch_read ON identity_workspace.onboarding_email FOR SELECT
USING (current_setting('mailflow.onboarding_delivery', true) = 'enabled');
CREATE POLICY onboarding_email_dispatch_update ON identity_workspace.onboarding_email FOR UPDATE
USING (current_setting('mailflow.onboarding_delivery', true) = 'enabled')
WITH CHECK (current_setting('mailflow.onboarding_delivery', true) = 'enabled');
