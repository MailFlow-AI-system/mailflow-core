DELETE FROM "mail"."message";--> statement-breakpoint
DROP INDEX "mail"."message_received_at_id_idx";--> statement-breakpoint
ALTER TABLE "mail"."message" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
CREATE INDEX "message_workspace_received_at_id_idx" ON "mail"."message" USING btree ("workspace_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "mail"."message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail"."message" FORCE ROW LEVEL SECURITY;
CREATE POLICY message_workspace ON "mail"."message"
USING (workspace_id = nullif(current_setting('mailflow.workspace_id', true), ''))
WITH CHECK (workspace_id = nullif(current_setting('mailflow.workspace_id', true), ''));
