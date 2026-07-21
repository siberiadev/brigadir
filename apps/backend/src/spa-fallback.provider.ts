import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { join } from 'node:path';

/** The built SPA dist dir; `WEB_DIST_PATH` overrides for tests/deploys (read at context init, rule #1). */
export function resolveWebDistPath(): string {
  return process.env.WEB_DIST_PATH ?? join(process.cwd(), 'apps', 'web', 'dist');
}

// Minimal structural typings for the express instance — express is a
// TRANSITIVE dep (via @nestjs/platform-express); under pnpm's strict linking
// it cannot be imported directly without declaring it, and we only need these
// three members.
interface SpaRequest {
  path: string;
}
interface SpaResponse {
  sendFile(name: string, opts: { root: string }, cb: (err?: Error) => void): void;
}
interface ExpressLikeApp {
  get(path: string, handler: (req: SpaRequest, res: SpaResponse, next: () => void) => void): void;
}

/**
 * SPA client-route fallback (T145), registered at onModuleInit so it lands
 * AFTER every controller route and the ServeStaticModule asset middleware but
 * BEFORE Nest's not-found handler (registerRouterHooks runs after init hooks).
 *
 * Why not ServeStaticModule's own `renderPath` fallback: its renderFn calls
 * `res.sendFile(<absolute index path>, null, …)` WITHOUT a `root` option, and
 * express's `send` then applies its default `dotfiles: 'ignore'` policy to
 * EVERY segment of the absolute path — any checkout living under a dot
 * directory (e.g. a `.claude/worktrees/...` git worktree) gets a
 * NotFoundError for a file that exists. With `root` set, only the segments
 * BELOW root are policed (which is also why the module's `express.static`
 * asset half works fine and only the fallback breaks). The module's own
 * fallback is therefore parked on a never-matching renderPath in
 * BackendAppModule, and this provider serves index.html root-relative.
 */
@Injectable()
export class SpaFallbackProvider implements OnModuleInit {
  private readonly logger = new Logger(SpaFallbackProvider.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const httpAdapter = this.adapterHost?.httpAdapter;
    if (!httpAdapter) return;
    const app = httpAdapter.getInstance<ExpressLikeApp>();
    const dist = resolveWebDistPath();

    app.get('/{*any}', (req, res, next) => {
      // `/api/*` and `/health` must never be shadowed by the SPA (T145):
      // unmatched API routes fall through to Nest's 404, not to index.html.
      if (req.path === '/health' || req.path === '/api' || req.path.startsWith('/api/')) {
        return next();
      }
      res.sendFile('index.html', { root: dist }, (err) => {
        // Missing dist (web not built yet) → Nest's 404, never a crash.
        if (err) next();
      });
    });
    this.logger.log(`SPA fallback registered (dist: ${dist})`);
  }
}
