import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  checkMcpServerArtifact,
  formatArtifactGuardError,
  resolveMcpServerEntryPath,
  resolveMcpServerSrcDir,
} from '@brigadir/executors';

/**
 * Deployment guard startup surface (feature 026, US2; Clarification Q1
 * hybrid). On boot, checks the agent tool-server artifact and — on a
 * missing/stale artifact — emits a loud, unmissable error banner. The worker
 * still starts (so mock/Phase-0 runs are never blocked); each callback-wired
 * run then hard-fails at pickup with the same explicit error
 * (ClaudeCliRunProcessor). A fresh build heals both surfaces without a
 * restart (the pickup guard is memoized, not boot-pinned).
 */
@Injectable()
export class ArtifactGuardBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(ArtifactGuardBootstrap.name);

  async onApplicationBootstrap(): Promise<void> {
    const verdict = await checkMcpServerArtifact({
      entryPath: resolveMcpServerEntryPath(),
      srcDir: resolveMcpServerSrcDir(),
    });
    if (!verdict.ok) {
      this.logger.error(formatArtifactGuardError(verdict));
      this.logger.error(
        'Callback-wired runs will FAIL at pickup until the tool-server artifact is rebuilt (mock/Phase-0 runs are unaffected).',
      );
    }
  }
}
