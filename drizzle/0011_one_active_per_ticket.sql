-- SXF-1174 Problem 6: tighten runs_one_active from (ticket_id, agent_id) to (ticket_id).
-- Defensive demotion first: live data may hold several active runs per ticket
-- (the exact incident state). Keep ONE per ticket — prefer the awaiting_human run
-- (its open blocking human task stays resumable), else the oldest — and cancel the
-- rest (same semantics as a dashboard cancel: the worker's cancel-poll kills a
-- running process, markRunning drops a cancelled queued job at pickup).
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY ticket_id
           ORDER BY (status = 'awaiting_human') DESC, created_at ASC, id ASC
         ) AS rn
  FROM runs
  WHERE ticket_id IS NOT NULL
    AND status IN ('queued', 'running', 'awaiting_human')
)
UPDATE runs SET status = 'cancelled', finished_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);--> statement-breakpoint
DROP INDEX "runs_one_active";--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active" ON "runs" USING btree ("ticket_id") WHERE status IN ('queued', 'running', 'awaiting_human');
