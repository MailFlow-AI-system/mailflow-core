CREATE TABLE "identity_workspace"."workspace_handoff" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity_workspace"."workspace_handoff" ADD CONSTRAINT "workspace_handoff_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity_workspace"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_workspace"."workspace_handoff" ADD CONSTRAINT "workspace_handoff_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "identity_workspace"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_handoff_expires_at_idx" ON "identity_workspace"."workspace_handoff" USING btree ("expires_at");