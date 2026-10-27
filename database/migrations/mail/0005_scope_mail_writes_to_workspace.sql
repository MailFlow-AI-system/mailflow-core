ALTER TABLE "mail"."attachment" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "mail"."outgoing_email_attachment" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "mail"."outgoing_email" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "mail"."outgoing_email" ADD COLUMN "delivery_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_workspace_identity_idx" ON "mail"."attachment" USING btree ("workspace_id","user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "outgoing_attachment_workspace_identity_idx" ON "mail"."outgoing_email_attachment" USING btree ("workspace_id","user_id","message_id","attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outgoing_email_workspace_identity_idx" ON "mail"."outgoing_email" USING btree ("workspace_id","user_id","id");--> statement-breakpoint
ALTER TABLE "mail"."outgoing_email_attachment" ADD CONSTRAINT "outgoing_email_attachment_workspace_id_user_id_message_id_outgoing_email_workspace_id_user_id_id_fk" FOREIGN KEY ("workspace_id","user_id","message_id") REFERENCES "mail"."outgoing_email"("workspace_id","user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail"."outgoing_email_attachment" ADD CONSTRAINT "outgoing_email_attachment_workspace_id_user_id_attachment_id_attachment_workspace_id_user_id_id_fk" FOREIGN KEY ("workspace_id","user_id","attachment_id") REFERENCES "mail"."attachment"("workspace_id","user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail"."attachment" ADD CONSTRAINT "attachment_workspace_required" CHECK ("mail"."attachment"."workspace_id" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "mail"."outgoing_email_attachment" ADD CONSTRAINT "outgoing_attachment_workspace_required" CHECK ("mail"."outgoing_email_attachment"."workspace_id" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "mail"."outgoing_email" ADD CONSTRAINT "outgoing_email_workspace_required" CHECK ("mail"."outgoing_email"."workspace_id" is not null) NOT VALID;