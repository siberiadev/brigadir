import { Module, DynamicModule, Provider, Global, OnModuleDestroy, Inject } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { DRIZZLE, PG_POOL, BrigadirDb } from './drizzle.constants';

export interface DatabaseModuleOptions {
  databaseUrl?: string;
}

@Global()
@Module({})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  static forRoot(options: DatabaseModuleOptions = {}): DynamicModule {
    const poolProvider: Provider = {
      provide: PG_POOL,
      useFactory: (): Pool => {
        const connectionString = options.databaseUrl ?? process.env.DATABASE_URL;
        if (!connectionString) {
          throw new Error('DATABASE_URL is not set');
        }
        // Pool connects lazily — constructing it does not require a live DB.
        return new Pool({ connectionString });
      },
    };

    const drizzleProvider: Provider = {
      provide: DRIZZLE,
      useFactory: (pool: Pool): BrigadirDb => drizzle(pool, { schema }),
      inject: [PG_POOL],
    };

    return {
      module: DatabaseModule,
      providers: [poolProvider, drizzleProvider],
      exports: [DRIZZLE, PG_POOL],
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
