CREATE TABLE "identity_workspace"."workspace_role" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_role_organization_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "workspace_role_name_present" CHECK (length(trim("identity_workspace"."workspace_role"."name")) between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "identity_workspace"."member" DROP CONSTRAINT "workspace_member_role";--> statement-breakpoint
ALTER TABLE "identity_workspace"."member" ADD COLUMN "custom_role_id" text;--> statement-breakpoint
ALTER TABLE "identity_workspace"."workspace_role" ADD CONSTRAINT "workspace_role_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity_workspace"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_role_name_unique" ON "identity_workspace"."workspace_role" USING btree ("organization_id",lower("name"));--> statement-breakpoint
ALTER TABLE "identity_workspace"."member" ADD CONSTRAINT "member_custom_role_same_organization_fk" FOREIGN KEY ("organization_id","custom_role_id") REFERENCES "identity_workspace"."workspace_role"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_workspace"."member" ADD CONSTRAINT "workspace_member_custom_role" CHECK (("identity_workspace"."member"."role" = 'custom') = ("identity_workspace"."member"."custom_role_id" is not null));--> statement-breakpoint
ALTER TABLE "identity_workspace"."member" ADD CONSTRAINT "workspace_member_role" CHECK ("identity_workspace"."member"."role" in ('owner', 'admin', 'member', 'manager', 'marketing_specialist', 'analyst', 'viewer', 'custom'));