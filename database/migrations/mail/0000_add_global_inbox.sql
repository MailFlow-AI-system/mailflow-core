CREATE SCHEMA "mail";
--> statement-breakpoint
CREATE TABLE "mail"."message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_name" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"received_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "message_received_at_id_idx" ON "mail"."message" USING btree ("received_at" DESC NULLS LAST,"id" DESC NULLS LAST);