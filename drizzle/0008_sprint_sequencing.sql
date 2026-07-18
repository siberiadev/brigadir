ALTER TABLE "tickets" ADD COLUMN "priority_id" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "priority_name" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "blocked_by" jsonb;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "blocked_state" text;