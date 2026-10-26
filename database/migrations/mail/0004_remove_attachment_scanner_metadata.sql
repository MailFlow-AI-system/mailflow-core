ALTER TABLE "mail"."attachment" DROP CONSTRAINT "attachment_clean_check";--> statement-breakpoint
ALTER TABLE "mail"."attachment" DROP COLUMN "scan_version";--> statement-breakpoint
ALTER TABLE "mail"."attachment" DROP COLUMN "scanned_at";--> statement-breakpoint
ALTER TABLE "mail"."attachment" ADD CONSTRAINT "attachment_clean_check" CHECK ("mail"."attachment"."status" <> 'clean' or "mail"."attachment"."final_key" is not null);