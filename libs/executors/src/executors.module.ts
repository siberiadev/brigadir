import { Module } from '@nestjs/common';
import { AppConfigModule, AGENTS_CONFIG } from '@brigadir/app-config';
import { DRIZZLE, type BrigadirDb } from '@brigadir/database';
import { JIRA_CLIENT, type JiraClient } from '@brigadir/jira';
import type { AgentsConfig } from '@brigadir/contracts';
import { MockExecutor } from './mock.executor';
import { ClaudeCliExecutor } from './claude-cli/claude-cli.executor';
import {
  MOONSHOT_ANTHROPIC_BASE_URL,
  DEEPSEEK_ANTHROPIC_BASE_URL,
} from './claude-cli/claude-cli.config';
import { ExecutorRegistry } from './executor.registry';
import { AGENT_EXECUTORS } from './agent-executor.interface';

/**
 * Module-private token for the second ClaudeCliExecutor instance (feature
 * 025): the SAME battle-tested class with the `kimi` provider preset —
 * Moonshot's Anthropic-compatible endpoint + implicit api_key-only auth. It
 * is deliberately NOT a subclass and NOT resolvable by class token (that
 * stays the claude_cli instance); only the registry sees it, by `type`.
 */
const KIMI_EXECUTOR = Symbol('KIMI_EXECUTOR');

/**
 * Module-private token for the third ClaudeCliExecutor instance (feature
 * 028): the same class with the `deepseek_api` provider preset — DeepSeek's
 * Anthropic-compatible endpoint + implicit api_key-only auth. Same rules as
 * KIMI_EXECUTOR: not a subclass, not class-token-resolvable, registry-only.
 */
const DEEPSEEK_EXECUTOR = Symbol('DEEPSEEK_EXECUTOR');

/**
 * ExecutorsModule — registers every AgentExecutor implementation and the
 * registry that resolves them by type. `claude_cli` (iteration 3) is the
 * first real executor to join `MockExecutor` (research F1); `kimi` (feature
 * 025) is the claude_cli harness parameterized with the Moonshot preset.
 * `AppConfigModule` is imported here (not left to each consuming app to
 * remember) so `ClaudeCliExecutor` can resolve `AGENTS_CONFIG` for its
 * repository lookup — same accepted "DatabaseModule.forRoot() imported more
 * than once" pattern already used by the backend app.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    MockExecutor,
    // Bare class provider = the claude_cli instance: the @Optional preset
    // resolves absent → `{ type: 'claude_cli' }`, behavior byte-identical.
    ClaudeCliExecutor,
    {
      provide: KIMI_EXECUTOR,
      useFactory: (db: BrigadirDb, agentsConfig: AgentsConfig | null, jira: JiraClient) =>
        new ClaudeCliExecutor(db, agentsConfig, jira, {
          type: 'kimi',
          anthropicBaseUrl: MOONSHOT_ANTHROPIC_BASE_URL,
        }),
      inject: [DRIZZLE, AGENTS_CONFIG, JIRA_CLIENT],
    },
    {
      provide: DEEPSEEK_EXECUTOR,
      useFactory: (db: BrigadirDb, agentsConfig: AgentsConfig | null, jira: JiraClient) =>
        new ClaudeCliExecutor(db, agentsConfig, jira, {
          type: 'deepseek_api',
          anthropicBaseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
        }),
      inject: [DRIZZLE, AGENTS_CONFIG, JIRA_CLIENT],
    },
    {
      provide: AGENT_EXECUTORS,
      useFactory: (
        mock: MockExecutor,
        claudeCli: ClaudeCliExecutor,
        kimi: ClaudeCliExecutor,
        deepseek: ClaudeCliExecutor,
      ) => [mock, claudeCli, kimi, deepseek],
      inject: [MockExecutor, ClaudeCliExecutor, KIMI_EXECUTOR, DEEPSEEK_EXECUTOR],
    },
    ExecutorRegistry,
  ],
  exports: [ExecutorRegistry],
})
export class ExecutorsModule {}
