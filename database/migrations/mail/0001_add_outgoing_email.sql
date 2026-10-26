CREATE TABLE "mail"."outgoing_email" (
	"id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"to" jsonb NOT NULL,
	"cc" jsonb NOT NULL,
	"bcc" jsonb NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"provider_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp (3) with time zone,
	CONSTRAINT "outgoing_email_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE INDEX "outgoing_email_user_sent_idx" ON "mail"."outgoing_email" USING btree ("user_id","sent_at" DESC NULLS LAST,"id" DESC NULLS LAST);