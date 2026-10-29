ALTER TABLE "mail"."message" ADD COLUMN "sender_email" text;--> statement-breakpoint
ALTER TABLE "mail"."message" ADD COLUMN "to" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mail"."message" ADD COLUMN "cc" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mail"."message" ADD COLUMN "bcc" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mail"."message" ADD COLUMN "html" text;