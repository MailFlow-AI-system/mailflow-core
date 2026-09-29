CREATE TABLE "identity_workspace"."rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limit_key_unique" ON "identity_workspace"."rate_limit" USING btree ("key");
