CREATE TABLE "identity_workspace"."workspace_preference" (
	"user_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity_workspace"."workspace_preference" ADD CONSTRAINT "workspace_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_workspace"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_workspace"."workspace_preference" ADD CONSTRAINT "workspace_preference_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "identity_workspace"."organization"("id") ON DELETE cascade ON UPDATE no action;