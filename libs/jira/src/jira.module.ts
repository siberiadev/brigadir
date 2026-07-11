import { Module, DynamicModule, Logger } from '@nestjs/common';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { JIRA_CLIENT } from './jira-client.interface';
import { BasicAuthJiraClient } from './basic-auth-jira.client';
import { decodeJiraCredentials } from './credentials.codec';
import { JiraAuthError } from './jira.errors';
import { WorkspaceConnectionService } from './workspace-connection.service';

/**
 * JiraModule (contracts.md C5 / research D2).
 *
 * `forRootAsync()` builds the JiraClient inside a DI factory at Nest context
 * init — it resolves the site URL + credentials from the `workspaces` row THEN,
 * never at module-import time and never from ambient env with a localhost
 * fallback (Constitution lazy resource resolution; the exact iteration-1 bug).
 * Rate-limit knobs are read from env INSIDE the factory (runtime), which is
 * allowed; only the client's connection identity comes from the DB row.
 */
@Module({})
export class JiraModule {
  static forRootAsync(): DynamicModule {
    // Relies on the globally-provided DRIZZLE (DatabaseModule is @Global and
    // composed once at the app root); importing DatabaseModule.forRoot() here
    // would spin up a second pool.
    return {
      module: JiraModule,
      providers: [
        {
          provide: JIRA_CLIENT,
          inject: [DRIZZLE],
          useFactory: async (db: BrigadirDb) => {
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
            logger.log(`Jira client resolved for ${ws.siteUrl} (context-init factory)`);
            return new BasicAuthJiraClient({
              baseUrl: ws.siteUrl,
              email: creds.email,
              apiToken: creds.api_token,
              maxRps: Number(process.env.JIRA_MAX_RPS ?? 5),
              concurrency: Number(process.env.JIRA_MAX_CONCURRENCY ?? 8),
            });
          },
        },
        WorkspaceConnectionService,
      ],
      exports: [JIRA_CLIENT, WorkspaceConnectionService],
    };
  }
}
