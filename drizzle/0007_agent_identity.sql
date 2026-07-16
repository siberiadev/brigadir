-- feature 014: split agent identity into id (internal) / key (LLM-UI handle) /
-- name+role (presentation). Drop UNIQUE(workspace_id, name), add role + key,
-- deterministically backfill key, then enforce NOT NULL + UNIQUE(workspace_id, key).
-- Backfill re-expresses slugifyAgentKey/ensureUniqueAgentKey in SQL; parity with
-- the TS functions is asserted by an integration test (see spec 014, task T018).
ALTER TABLE "agents" DROP CONSTRAINT "agents_workspace_name";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "key" text;--> statement-breakpoint
-- Orchestrators: reserved key + role. is_orchestrator (not name) identifies them.
UPDATE "agents" SET "role" = 'teamlead', "key" = 'brigadir' WHERE "is_orchestrator" = true;--> statement-breakpoint
-- Workers: key = slug(name), role left NULL. Deterministic per-workspace collision
-- resolution in id order (matches ensureUniqueAgentKey: smallest free -2/-3 suffix,
-- reserved 'brigadir' always taken). Slug rule mirrors slugifyAgentKey exactly.
DO $$
DECLARE
  ws RECORD;
  ag RECORD;
  base text;
  candidate text;
  n int;
  taken text[];
BEGIN
  FOR ws IN SELECT DISTINCT workspace_id FROM agents LOOP
    -- reserved keys count as taken (a worker can never hold the orchestrator key)
    taken := ARRAY['brigadir'];
    FOR ag IN
      SELECT id, name FROM agents
      WHERE workspace_id = ws.workspace_id AND is_orchestrator = false
      ORDER BY id
    LOOP
      base := nullif(trim(both '-' from regexp_replace(lower(ag.name), '[^a-z0-9]+', '-', 'g')), '');
      IF base IS NULL THEN
        base := 'agent';
      END IF;
      candidate := base;
      n := 2;
      WHILE candidate = ANY(taken) LOOP
        candidate := base || '-' || n;
        n := n + 1;
      END LOOP;
      taken := array_append(taken, candidate);
      UPDATE agents SET key = candidate WHERE id = ag.id;
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_key" UNIQUE("workspace_id","key");
