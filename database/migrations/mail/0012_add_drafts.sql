CREATE TABLE "mail"."draft_attachment" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"draft_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"content_id" text,
	CONSTRAINT "draft_attachment_workspace_id_user_id_draft_id_attachment_id_pk" PRIMARY KEY("workspace_id","user_id","draft_id","attachment_id"),
	CONSTRAINT "draft_attachment_position_check" CHECK ("mail"."draft_attachment"."position" >= 0 and "mail"."draft_attachment"."position" < 10)
);
--> statement-breakpoint
CREATE TABLE "mail"."draft" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"mutation_id" uuid,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_workspace_id_user_id_id_pk" PRIMARY KEY("workspace_id","user_id","id"),
	CONSTRAINT "draft_state_check" CHECK ("mail"."draft"."state" in ('active', 'discarded', 'sent')),
	CONSTRAINT "draft_version_check" CHECK ("mail"."draft"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "mail"."draft" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mail"."draft" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mail"."draft_attachment" ADD CONSTRAINT "draft_attachment_workspace_id_user_id_draft_id_draft_workspace_id_user_id_id_fk" FOREIGN KEY ("workspace_id","user_id","draft_id") REFERENCES "mail"."draft"("workspace_id","user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail"."draft_attachment" ADD CONSTRAINT "draft_attachment_workspace_id_user_id_attachment_id_attachment_workspace_id_user_id_id_fk" FOREIGN KEY ("workspace_id","user_id","attachment_id") REFERENCES "mail"."attachment"("workspace_id","user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "draft_attachment_owner_idx" ON "mail"."draft_attachment" USING btree ("workspace_id","user_id","attachment_id");--> statement-breakpoint
CREATE INDEX "draft_owner_updated_idx" ON "mail"."draft" USING btree ("workspace_id","user_id","state","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "draft_owner" ON "mail"."draft" AS PERMISSIVE FOR ALL TO public USING ("mail"."draft"."workspace_id" = nullif(current_setting('mailflow.workspace_id', true), '') and "mail"."draft"."user_id" = nullif(current_setting('mailflow.user_id', true), '')) WITH CHECK ("mail"."draft"."workspace_id" = nullif(current_setting('mailflow.workspace_id', true), '') and "mail"."draft"."user_id" = nullif(current_setting('mailflow.user_id', true), ''));
