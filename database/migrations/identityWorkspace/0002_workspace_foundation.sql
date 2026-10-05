CREATE TABLE "identity_workspace"."organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_slug_dns_safe" CHECK ("identity_workspace"."organization"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("identity_workspace"."organization"."slug") <= 63),
	CONSTRAINT "workspace_name_present" CHECK (length(trim("identity_workspace"."organization"."name")) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "identity_workspace"."invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text NOT NULL,
	"inviter_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_workspace"."member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_member_role" CHECK ("identity_workspace"."member"."role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
ALTER TABLE "identity_workspace"."session" ADD COLUMN "active_organization_id" text;--> statement-breakpoint
ALTER TABLE "identity_workspace"."invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity_workspace"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_workspace"."invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "identity_workspace"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_workspace"."member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity_workspace"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_workspace"."member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_workspace"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_slug_unique" ON "identity_workspace"."organization" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_member_unique" ON "identity_workspace"."member" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_one_owner" ON "identity_workspace"."member" USING btree ("organization_id") WHERE "identity_workspace"."member"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "workspace_member_user" ON "identity_workspace"."member" USING btree ("user_id");