import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import type { AgentsConfig } from '@brigadir/contracts';
import { AGENTS_CONFIG } from './agents-config.provider';

/**
 * yaml → DB seeder (T017).
 *
 * On backend boot, upserts the single workspace, its executors, and its agents
 * from the validated agents.yaml into Postgres (research D6). Idempotent: a
 * re-run leaves exactly one row set (matched on the natural keys — workspace
 * name and the UNIQUE(workspace_id, name) on executors/agents).
 *
 * `jira_credentials` is NOT NULL in §3; iteration 1 seeds placeholder bytes
 * (no encryption machinery yet — research D6 / spec assumption).
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
    @Inject(AGENTS_CONFIG) private readonly config: AgentsConfig,
  ) {}

  async seed(): Promise<SeedResult> {
    const { workspace, executors, agents } = this.config;
    // Workspace name is not part of the yaml shape; derive a stable one from
    // the Jira project key so re-runs match the same row.
    const workspaceName = workspace.project_key;

    return this.db.transaction(async (tx) => {
      // --- workspace (no unique constraint → find-or-insert on name) ---
      const existing = await tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.name, workspaceName))
        .limit(1);

      let workspaceId: string;
      const workspaceValues = {
        name: workspaceName,
        jiraSiteUrl: workspace.jira_site,
        jiraProjectKey: workspace.project_key,
        settings: { repo: workspace.repo, default_branch: workspace.default_branch },
      };

      if (existing.length > 0) {
        workspaceId = existing[0].id;
        await tx
          .update(schema.workspaces)
          .set({ ...workspaceValues, updatedAt: new Date() })
          .where(eq(schema.workspaces.id, workspaceId));
      } else {
        const [row] = await tx
          .insert(schema.workspaces)
          .values({ ...workspaceValues, jiraCredentials: PLACEHOLDER_JIRA_CREDENTIALS })
          .returning({ id: schema.workspaces.id });
        workspaceId = row.id;
      }

      // --- executors (UNIQUE(workspace_id, name) → onConflictDoUpdate) ---
      const executorIds: Record<string, string> = {};
      for (const [name, exec] of Object.entries(executors)) {
        const { type, concurrency, ...rest } = exec;
        const [row] = await tx
          .insert(schema.executors)
          .values({
            workspaceId,
            name,
            type,
            concurrencyLimit: concurrency,
            config: rest,
          })
          .onConflictDoUpdate({
            target: [schema.executors.workspaceId, schema.executors.name],
            set: { type, concurrencyLimit: concurrency, config: rest },
          })
          .returning({ id: schema.executors.id });
        executorIds[name] = row.id;
      }

      // --- agents (UNIQUE(workspace_id, name) → onConflictDoUpdate) ---
      const agentIds: Record<string, string> = {};
      for (const agent of agents) {
        const executorId = executorIds[agent.executor];
        if (!executorId) {
          // Cross-ref already validated by AgentsConfigSchema.superRefine; guard anyway.
          throw new Error(`agent "${agent.name}" references unknown executor "${agent.executor}"`);
        }
        const values = {
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
        };
        const [row] = await tx
          .insert(schema.agents)
          .values(values)
          .onConflictDoUpdate({
            target: [schema.agents.workspaceId, schema.agents.name],
            set: {
              executorId,
              instruction: values.instruction,
              triggerStatus: values.triggerStatus,
              triggerJql: values.triggerJql,
              statusRunning: values.statusRunning,
              statusSuccess: values.statusSuccess,
              statusFailure: values.statusFailure,
              behavior: values.behavior,
              timeoutMinutes: values.timeoutMinutes,
              maxBudgetUsd: values.maxBudgetUsd,
              maxAttempts: values.maxAttempts,
            },
          })
          .returning({ id: schema.agents.id });
        agentIds[agent.name] = row.id;
      }

      this.logger.log(
        `seeded workspace "${workspaceName}" (${Object.keys(executorIds).length} executors, ${Object.keys(agentIds).length} agents)`,
      );

      return { workspaceId, executorIds, agentIds };
    });
  }
}
