import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import type { AgentsConfig } from '@brigadir/contracts';
import { AGENTS_CONFIG } from './agents-config.provider';

/**
 * yaml → DB seeder (T017), flipped to **insert-if-absent** in feature 005 (R4 /
 * FR-016/FR-017): the DB is now authoritative. On boot the seeder imports the
 * single workspace, its executors, and its agents from agents.yaml ONLY for rows
 * that do not already exist — an existing row (workspace matched on `name`,
 * executors on the GLOBAL `UNIQUE(name)` — platform-scoped since migration
 * 0003 — agents on `UNIQUE(workspace_id, name)`) is **never** overwritten from
 * the yaml. UI edits are the sole post-import mutation channel.
 *
 * The yaml is optional (FR-019): `AGENTS_CONFIG` is `null` when the file is
 * absent, in which case `seed()` is a no-op and returns `null`.
 *
 * `jira_credentials` is NOT NULL in §3; a brand-new yaml-seeded workspace gets
 * placeholder bytes (migrated/rotated to a real encrypted blob later).
 */

const PLACEHOLDER_JIRA_CREDENTIALS = Buffer.from('placeholder-jira-credentials');

export interface SeedResult {
  workspaceId: string;
  executorIds: Record<string, string>;
  agentIds: Record<string, string>;
}

@Injectable()
export class ConfigSeeder {
  private readonly logger = new Logger(ConfigSeeder.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    @Inject(AGENTS_CONFIG) private readonly config: AgentsConfig | null,
  ) {}

  async seed(): Promise<SeedResult | null> {
    if (!this.config) {
      this.logger.log('no agents.yaml present — DB-authoritative boot, seeder skipped');
      return null;
    }
    const { workspace, executors, agents } = this.config;
    // Workspace name is not part of the yaml shape; derive a stable one from
    // the Jira project key so re-runs match the same row.
    const workspaceName = workspace.project_key;

    return this.db.transaction(async (tx) => {
      // --- workspace: insert-if-absent (matched on name; DB wins) ---
      const existing = await tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.name, workspaceName))
        .limit(1);

      let workspaceId: string;
      let inserted = false;
      if (existing.length > 0) {
        // Row exists → do nothing (FR-017). UI edits are authoritative.
        workspaceId = existing[0].id;
      } else {
        const settings = {
          ...(workspace.scope_jql !== undefined ? { scope_jql: workspace.scope_jql } : {}),
          ...(workspace.branch_prefix !== undefined
            ? { branch_prefix: workspace.branch_prefix }
            : {}),
          ...(workspace.repo !== undefined ? { repo: workspace.repo } : {}),
          ...(workspace.default_branch !== undefined
            ? { default_branch: workspace.default_branch }
            : {}),
        };
        const [row] = await tx
          .insert(schema.workspaces)
          .values({
            name: workspaceName,
            jiraSiteUrl: workspace.jira_site,
            jiraProjectKey: workspace.project_key,
            jiraBoardId: workspace.board_id,
            settings,
            jiraCredentials: PLACEHOLDER_JIRA_CREDENTIALS,
          })
          .returning({ id: schema.workspaces.id });
        workspaceId = row.id;
        inserted = true;
      }

      // --- executors: insert-if-absent (existing rows kept; ids resolved) ---
      // PLATFORM-scoped since migration 0003: matched on the GLOBAL name — a
      // yaml executor whose name already exists anywhere is reused, not
      // re-created. The yaml-era `repository` key is not persisted: a run's
      // repository resolves from `agents.behavior.repository`, else the run
      // workspace's default repository.
      const executorIds: Record<string, string> = {};
      for (const [name, exec] of Object.entries(executors)) {
        const { type, concurrency, ...rest } = exec;
        delete (rest as Record<string, unknown>).repository;
        const found = await tx
          .select({ id: schema.executors.id })
          .from(schema.executors)
          .where(eq(schema.executors.name, name))
          .limit(1);
        if (found.length > 0) {
          executorIds[name] = found[0].id;
          continue;
        }
        const [row] = await tx
          .insert(schema.executors)
          .values({ name, type, concurrencyLimit: concurrency, config: rest })
          .returning({ id: schema.executors.id });
        executorIds[name] = row.id;
      }

      // --- agents: insert-if-absent (existing rows kept; ids resolved) ---
      const agentIds: Record<string, string> = {};
      for (const agent of agents) {
        const executorId = executorIds[agent.executor];
        if (!executorId) {
          throw new Error(`agent "${agent.name}" references unknown executor "${agent.executor}"`);
        }
        const found = await tx
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(
            and(
              eq(schema.agents.workspaceId, workspaceId),
              eq(schema.agents.name, agent.name),
            ),
          )
          .limit(1);
        if (found.length > 0) {
          agentIds[agent.name] = found[0].id;
          continue;
        }
        const [row] = await tx
          .insert(schema.agents)
          .values({
            workspaceId,
            executorId,
            name: agent.name,
            instruction: agent.instruction,
            triggerStatus: agent.trigger_status ?? null,
            triggerJql: agent.trigger_jql ?? null,
            statusRunning: agent.status_running ?? null,
            statusSuccess: agent.status_success,
            statusFailure: agent.status_failure,
            behavior: agent.behavior ?? {},
            timeoutMinutes: agent.timeout_minutes,
            maxBudgetUsd: agent.max_budget_usd !== undefined ? String(agent.max_budget_usd) : null,
            maxAttempts: agent.max_attempts,
          })
          .returning({ id: schema.agents.id });
        agentIds[agent.name] = row.id;
      }

      this.logger.log(
        `${inserted ? 'seeded' : 'reconciled'} workspace "${workspaceName}" (insert-if-absent: ${Object.keys(executorIds).length} executors, ${Object.keys(agentIds).length} agents)`,
      );

      return { workspaceId, executorIds, agentIds };
    });
  }
}
