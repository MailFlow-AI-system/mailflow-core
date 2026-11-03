CREATE TABLE "mail"."label" (
	"workspace_id" text NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	CONSTRAINT "label_workspace_id_id_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "label_name_length_check" CHECK (char_length("mail"."label"."name") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "mail"."label" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mail"."message_label" (
	"workspace_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "message_label_workspace_id_message_id_label_id_pk" PRIMARY KEY("workspace_id","message_id","label_id")
);
--> statement-breakpoint
ALTER TABLE "mail"."message_label" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mail"."sent_label" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "sent_label_workspace_id_user_id_message_id_label_id_pk" PRIMARY KEY("workspace_id","user_id","message_id","label_id")
);
--> statement-breakpoint
ALTER TABLE "mail"."sent_label" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mail"."message_label" ADD CONSTRAINT "message_label_workspace_id_message_id_message_workspace_id_id_fk" FOREIGN KEY ("workspace_id","message_id") REFERENCES "mail"."message"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail"."message_label" ADD CONSTRAINT "message_label_workspace_id_label_id_label_workspace_id_id_fk" FOREIGN KEY ("workspace_id","label_id") REFERENCES "mail"."label"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail"."sent_label" ADD CONSTRAINT "sent_label_workspace_id_user_id_message_id_outgoing_email_workspace_id_user_id_id_fk" FOREIGN KEY ("workspace_id","user_id","message_id") REFERENCES "mail"."outgoing_email"("workspace_id","user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail"."sent_label" ADD CONSTRAINT "sent_label_workspace_id_label_id_label_workspace_id_id_fk" FOREIGN KEY ("workspace_id","label_id") REFERENCES "mail"."label"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "label_workspace_name_idx" ON "mail"."label" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE POLICY "label_workspace" ON "mail"."label" AS PERMISSIVE FOR ALL TO public USING ("mail"."label"."workspace_id" = nullif(current_setting('mailflow.workspace_id', true), '')) WITH CHECK ("mail"."label"."workspace_id" = nullif(current_setting('mailflow.workspace_id', true), ''));--> statement-breakpoint
CREATE POLICY "message_label_workspace" ON "mail"."message_label" AS PERMISSIVE FOR ALL TO public USING ("mail"."message_label"."workspace_id" = nullif(current_setting('mailflow.workspace_id', true), '')) WITH CHECK ("mail"."message_label"."workspace_id" = nullif(current_setting('mailflow.workspace_id', true), ''));--> statement-breakpoint
CREATE POLICY "sent_label_workspace" ON "mail"."sent_label" AS PERMISSIVE FOR ALL TO public USING ("mail"."sent_label"."workspace_id" = nullif(current_setting('mailflow.workspace_id', true), '')) WITH CHECK ("mail"."sent_label"."workspace_id" = nullif(current_setting('mailflow.workspace_id', true), ''));--> statement-breakpoint
ALTER TABLE "mail"."label" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mail"."message_label" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mail"."sent_label" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mailflow_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mail.label, mail.message_label, mail.sent_label TO mailflow_runtime;
  END IF;
END $$;
