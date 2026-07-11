import { Module } from '@nestjs/common';
import { AppConfigModule } from '@brigadir/app-config';
import { MockExecutor } from './mock.executor';
import { ClaudeCliExecutor } from './claude-cli/claude-cli.executor';
import { ExecutorRegistry } from './executor.registry';
import { AGENT_EXECUTORS } from './agent-executor.interface';

/**
 * ExecutorsModule — registers every AgentExecutor implementation and the
 * registry that resolves them by type. `claude_cli` (iteration 3) is the
 * first real executor to join `MockExecutor` (research F1). `AppConfigModule`
 * is imported here (not left to each consuming app to remember) so
 * `ClaudeCliExecutor` can resolve `AGENTS_CONFIG` for its repository lookup —
 * same accepted "DatabaseModule.forRoot() imported more than once" pattern
 * already used by the backend app.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    MockExecutor,
    ClaudeCliExecutor,
    {
      provide: AGENT_EXECUTORS,
      useFactory: (mock: MockExecutor, claudeCli: ClaudeCliExecutor) => [mock, claudeCli],
      inject: [MockExecutor, ClaudeCliExecutor],
    },
    ExecutorRegistry,
  ],
  exports: [ExecutorRegistry],
})
export class ExecutorsModule {}
