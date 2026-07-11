import { Injectable, Inject } from '@nestjs/common';
import { AGENT_EXECUTORS, type AgentExecutor } from './agent-executor.interface';

/** Resolves an AgentExecutor by its `type` (architecture §4). */
@Injectable()
export class ExecutorRegistry {
  private readonly byType = new Map<string, AgentExecutor>();

  constructor(@Inject(AGENT_EXECUTORS) executors: AgentExecutor[]) {
    for (const executor of executors) {
      this.byType.set(executor.type, executor);
    }
  }

  resolve(type: string): AgentExecutor {
    const executor = this.byType.get(type);
    if (!executor) {
      throw new Error(`no executor registered for type "${type}"`);
    }
    return executor;
  }

  has(type: string): boolean {
    return this.byType.has(type);
  }
}
