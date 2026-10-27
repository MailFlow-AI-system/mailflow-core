ALTER TABLE "mail"."outgoing_email" ADD COLUMN "delivery_state" text DEFAULT 'uncertain' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail"."outgoing_email" ADD COLUMN "attempt_token" uuid;--> statement-breakpoint
ALTER TABLE "mail"."outgoing_email" ADD CONSTRAINT "outgoing_email_delivery_state_check" CHECK ("mail"."outgoing_email"."delivery_state" in ('ready', 'rejected', 'uncertain', 'sent', 'discarded'));
