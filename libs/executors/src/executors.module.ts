import { Module } from '@nestjs/common';
import { MockExecutor } from './mock.executor';
import { ExecutorRegistry } from './executor.registry';
import { AGENT_EXECUTORS } from './agent-executor.interface';

/**
 * ExecutorsModule — registers every AgentExecutor implementation and the
 * registry that resolves them by type. Iteration 1 ships only MockExecutor
 * (research F1); the four real executors join in later iterations.
 */
@Module({
  providers: [
    MockExecutor,
    {
      provide: AGENT_EXECUTORS,
      useFactory: (mock: MockExecutor) => [mock],
      inject: [MockExecutor],
    },
    ExecutorRegistry,
  ],
  exports: [ExecutorRegistry],
})
export class ExecutorsModule {}
