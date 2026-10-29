CREATE TABLE "mail"."inbox_message_attachment" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"content_id" text,
	CONSTRAINT "inbox_message_attachment_workspace_id_user_id_message_id_position_pk" PRIMARY KEY("workspace_id","user_id","message_id","position"),
	CONSTRAINT "inbox_attachment_position_check" CHECK ("mail"."inbox_message_attachment"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "message_workspace_identity_idx" ON "mail"."message" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "mail"."inbox_message_attachment" ADD CONSTRAINT "inbox_message_attachment_workspace_id_message_id_message_workspace_id_id_fk" FOREIGN KEY ("workspace_id","message_id") REFERENCES "mail"."message"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail"."inbox_message_attachment" ADD CONSTRAINT "inbox_message_attachment_workspace_id_user_id_attachment_id_attachment_workspace_id_user_id_id_fk" FOREIGN KEY ("workspace_id","user_id","attachment_id") REFERENCES "mail"."attachment"("workspace_id","user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
