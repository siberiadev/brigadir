import { Module, DynamicModule, Logger } from '@nestjs/common';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { JIRA_CLIENT } from './jira-client.interface';
import { BasicAuthJiraClient } from './basic-auth-jira.client';
import { LazyJiraClient } from './lazy-jira.client';
import { decodeJiraCredentials } from './credentials.codec';
import { JiraAuthError } from './jira.errors';
import { WorkspaceConnectionService } from './workspace-connection.service';

/**
 * JiraModule (contracts.md C5 / research D2).
 *
 * `forRootAsync()` provides a LAZY JiraClient: the DI factory builds only a
 * `LazyJiraClient` wrapper at context init — it reads NOTHING from the DB and
 * touches NO credentials until the first Jira call. The site URL + credentials
 * are resolved from the `workspaces` row on first use (never at module-import
 * time, never from ambient env with a localhost fallback — Constitution lazy
 * resource resolution; the exact iteration-1 bug). This keeps the worker's boot
 * credential-free: a reconcile pass resolves the client lazily, and a boot with
 * no Jira credentials configured never crashes.
 *
 * Rate-limit knobs are read from env INSIDE the resolver (runtime), which is
 * allowed; only the client's connection identity comes from the DB row. The
 * module is `global` so a single root import exposes JIRA_CLIENT app-wide
 * (pipeline + ingest inject it without re-importing / re-resolving).
 */
@Module({})
export class JiraModule {
  static forRootAsync(): DynamicModule {
    // Relies on the globally-provided DRIZZLE (DatabaseModule is @Global and
    // composed once at the app root); importing DatabaseModule.forRoot() here
    // would spin up a second pool.
    return {
      module: JiraModule,
      global: true,
      providers: [
        {
          provide: JIRA_CLIENT,
          inject: [DRIZZLE],
          useFactory: (db: BrigadirDb) =>
            new LazyJiraClient(async () => {
              const logger = new Logger(JiraModule.name);
              const [ws] = await db
                .select({
                  siteUrl: schema.workspaces.jiraSiteUrl,
                  credentials: schema.workspaces.jiraCredentials,
                })
                .from(schema.workspaces)
                .limit(1);
              if (!ws) {
                throw new JiraAuthError('no workspace configured — cannot build a Jira client');
              }
              const creds = decodeJiraCredentials(ws.credentials as Buffer);
              logger.log(`Jira client resolved for ${ws.siteUrl} (lazy, first-use)`);
              return new BasicAuthJiraClient({
                baseUrl: ws.siteUrl,
                email: creds.email,
                apiToken: creds.api_token,
                maxRps: Number(process.env.JIRA_MAX_RPS ?? 5),
                concurrency: Number(process.env.JIRA_MAX_CONCURRENCY ?? 8),
              });
            }),
        },
        WorkspaceConnectionService,
      ],
      exports: [JIRA_CLIENT, WorkspaceConnectionService],
    };
  }
}
