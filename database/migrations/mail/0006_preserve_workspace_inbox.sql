ALTER TABLE "mail"."message" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "mail"."message" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "mail"."message_received_at_id_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_workspace_received_at_id_idx" ON "mail"."message" USING btree ("workspace_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "mail"."message" ADD CONSTRAINT "message_workspace_required" CHECK ("mail"."message"."workspace_id" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "mail"."message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mail"."message" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "message_workspace" ON "mail"."message";--> statement-breakpoint
CREATE POLICY "message_workspace" ON "mail"."message" AS PERMISSIVE FOR ALL TO public USING ("mail"."message"."workspace_id" = nullif(current_setting('mailflow.workspace_id', true), '')) WITH CHECK ("mail"."message"."workspace_id" = nullif(current_setting('mailflow.workspace_id', true), ''));
