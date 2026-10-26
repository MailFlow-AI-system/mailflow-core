CREATE TABLE "mail"."attachment" (
	"id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"status" text NOT NULL,
	"temporary_key" text NOT NULL,
	"final_key" text,
	"scan_version" text,
	"rejection_reason" text,
	"scanned_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	"claim_token" text,
	"claim_expires_at" timestamp (3) with time zone,
	CONSTRAINT "attachment_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "attachment_size_check" CHECK ("mail"."attachment"."size" >= 0 and "mail"."attachment"."size" <= 10000000),
	CONSTRAINT "attachment_sha256_check" CHECK ("mail"."attachment"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "attachment_status_check" CHECK ("mail"."attachment"."status" in ('pending', 'clean', 'rejected', 'error', 'deleting')),
	CONSTRAINT "attachment_clean_check" CHECK ("mail"."attachment"."status" <> 'clean' or ("mail"."attachment"."final_key" is not null and "mail"."attachment"."scan_version" is not null and "mail"."attachment"."scanned_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "mail"."outgoing_email_attachment" (
	"user_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"content_id" text,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	CONSTRAINT "outgoing_email_attachment_user_id_message_id_position_pk" PRIMARY KEY("user_id","message_id","position"),
	CONSTRAINT "outgoing_attachment_position_check" CHECK ("mail"."outgoing_email_attachment"."position" >= 0 and "mail"."outgoing_email_attachment"."position" < 10)
);
--> statement-breakpoint
ALTER TABLE "mail"."outgoing_email_attachment" ADD CONSTRAINT "outgoing_email_attachment_user_id_message_id_outgoing_email_user_id_id_fk" FOREIGN KEY ("user_id","message_id") REFERENCES "mail"."outgoing_email"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail"."outgoing_email_attachment" ADD CONSTRAINT "outgoing_email_attachment_user_id_attachment_id_attachment_user_id_id_fk" FOREIGN KEY ("user_id","attachment_id") REFERENCES "mail"."attachment"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_temporary_key_idx" ON "mail"."attachment" USING btree ("temporary_key");--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_final_key_idx" ON "mail"."attachment" USING btree ("final_key");--> statement-breakpoint
CREATE INDEX "attachment_expiry_idx" ON "mail"."attachment" USING btree ("expires_at","status");--> statement-breakpoint
CREATE UNIQUE INDEX "outgoing_attachment_identity_idx" ON "mail"."outgoing_email_attachment" USING btree ("user_id","message_id","attachment_id");--> statement-breakpoint
CREATE INDEX "outgoing_attachment_owner_idx" ON "mail"."outgoing_email_attachment" USING btree ("user_id","attachment_id");
