CREATE TABLE "identity_workspace"."onboarding_email" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_email_kind" CHECK ("identity_workspace"."onboarding_email"."kind" in ('verification-otp', 'verified-welcome')),
	CONSTRAINT "onboarding_email_state" CHECK ("identity_workspace"."onboarding_email"."state" in ('pending', 'leased', 'sent', 'expired')),
	CONSTRAINT "onboarding_email_attempts" CHECK ("identity_workspace"."onboarding_email"."attempts" between 0 and 5)
);
--> statement-breakpoint
CREATE TABLE "identity_workspace"."onboarding_signup" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_signup_hashes" CHECK ("identity_workspace"."onboarding_signup"."key_hash" ~ '^[0-9a-f]{64}$' and "identity_workspace"."onboarding_signup"."fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "identity_workspace"."onboarding_email" ADD CONSTRAINT "onboarding_email_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_workspace"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_workspace"."onboarding_signup" ADD CONSTRAINT "onboarding_signup_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_workspace"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_workspace"."onboarding_signup" ADD CONSTRAINT "onboarding_signup_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity_workspace"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_email_pending" ON "identity_workspace"."onboarding_email" USING btree ("state","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_signup_user_unique" ON "identity_workspace"."onboarding_signup" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_signup_workspace_unique" ON "identity_workspace"."onboarding_signup" USING btree ("organization_id");