ALTER TABLE "runs" ALTER COLUMN "ticket_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "human_tasks" ALTER COLUMN "ticket_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_setup" ON "runs" USING btree ("workspace_id") WHERE status IN ('queued', 'running', 'awaiting_human') AND ticket_id IS NULL;