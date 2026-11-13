CREATE TABLE "mail"."message_user_state" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"read_at" timestamp (3) with time zone,
	"starred_at" timestamp (3) with time zone,
	CONSTRAINT "message_user_state_workspace_id_user_id_message_id_pk" PRIMARY KEY("workspace_id","user_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "mail"."message_user_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mail"."message" ADD COLUMN "archived_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mail"."message" ADD COLUMN "archived_by" text;--> statement-breakpoint
ALTER TABLE "mail"."message" ADD COLUMN "trashed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mail"."message" ADD COLUMN "trashed_by" text;--> statement-breakpoint
ALTER TABLE "mail"."message" ADD COLUMN "spam_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mail"."message" ADD COLUMN "spam_by" text;--> statement-breakpoint
ALTER TABLE "mail"."message_user_state" ADD CONSTRAINT "message_user_state_workspace_id_message_id_message_workspace_id_id_fk" FOREIGN KEY ("workspace_id","message_id") REFERENCES "mail"."message"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_user_state_message_idx" ON "mail"."message_user_state" USING btree ("workspace_id","message_id");--> statement-breakpoint
CREATE INDEX "message_inbox_folder_idx" ON "mail"."message" USING btree ("workspace_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "mail"."message"."archived_at" is null and "mail"."message"."trashed_at" is null and "mail"."message"."spam_at" is null;--> statement-breakpoint
CREATE INDEX "message_archive_folder_idx" ON "mail"."message" USING btree ("workspace_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "mail"."message"."archived_at" is not null and "mail"."message"."trashed_at" is null and "mail"."message"."spam_at" is null;--> statement-breakpoint
CREATE INDEX "message_trash_folder_idx" ON "mail"."message" USING btree ("workspace_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "mail"."message"."trashed_at" is not null;--> statement-breakpoint
CREATE INDEX "message_spam_folder_idx" ON "mail"."message" USING btree ("workspace_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "mail"."message"."spam_at" is not null and "mail"."message"."trashed_at" is null;--> statement-breakpoint
ALTER TABLE "mail"."message" ADD CONSTRAINT "message_archived_actor_check" CHECK (("mail"."message"."archived_at" is null) = ("mail"."message"."archived_by" is null));--> statement-breakpoint
ALTER TABLE "mail"."message" ADD CONSTRAINT "message_trashed_actor_check" CHECK (("mail"."message"."trashed_at" is null) = ("mail"."message"."trashed_by" is null));--> statement-breakpoint
ALTER TABLE "mail"."message" ADD CONSTRAINT "message_spam_actor_check" CHECK (("mail"."message"."spam_at" is null) = ("mail"."message"."spam_by" is null));--> statement-breakpoint
CREATE POLICY "message_user_state_owner" ON "mail"."message_user_state" AS PERMISSIVE FOR ALL TO public USING ("mail"."message_user_state"."workspace_id" = nullif(current_setting('mailflow.workspace_id', true), '') and "mail"."message_user_state"."user_id" = nullif(current_setting('mailflow.user_id', true), '')) WITH CHECK ("mail"."message_user_state"."workspace_id" = nullif(current_setting('mailflow.workspace_id', true), '') and "mail"."message_user_state"."user_id" = nullif(current_setting('mailflow.user_id', true), ''));--> statement-breakpoint
ALTER TABLE "mail"."message_user_state" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mailflow_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mail.message_user_state TO mailflow_runtime;
  END IF;
END $$;
