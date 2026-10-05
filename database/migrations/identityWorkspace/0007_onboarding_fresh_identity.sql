ALTER POLICY onboarding_receipt_insert ON identity_workspace.onboarding_signup
WITH CHECK (
  key_hash = nullif(current_setting('mailflow.onboarding_key', true), '')
  AND user_id = nullif(current_setting('mailflow.user_id', true), '')
  AND organization_id = nullif(current_setting('mailflow.onboarding_workspace', true), '')
  AND NOT EXISTS (SELECT 1 FROM identity_workspace."user" u WHERE u.id = onboarding_signup.user_id)
  AND NOT EXISTS (SELECT 1 FROM identity_workspace.organization o WHERE o.id = onboarding_signup.organization_id)
);
--> statement-breakpoint
-- A resend retires unsent codes for this identity only. A leased effect may
-- already be in flight; OTP rotation remains the authoritative validity check.
CREATE POLICY onboarding_email_replace_read ON identity_workspace.onboarding_email FOR SELECT
USING (user_id = nullif(current_setting('mailflow.user_id', true), '') AND kind = 'verification-otp');
CREATE POLICY onboarding_email_replace_update ON identity_workspace.onboarding_email FOR UPDATE
USING (user_id = nullif(current_setting('mailflow.user_id', true), '') AND kind = 'verification-otp' AND state = 'pending')
WITH CHECK (user_id = nullif(current_setting('mailflow.user_id', true), '') AND kind = 'verification-otp'
  AND state = 'expired' AND payload IS NULL AND lease_token IS NULL AND lease_until IS NULL);
