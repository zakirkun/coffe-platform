import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { AppConfig } from '../config/env.js';
import { createDatabase, type Database, type DatabaseHandle, type Schema } from './client.js';
import { runMigrations } from './migrate.js';

/** Injection token for the Drizzle `Database`. */
export const DB = Symbol('DB');
/** Injection token for the shared node-postgres pool (Drizzle, Better Auth, pg-boss). */
export const PG_POOL = Symbol('PG_POOL');
const DB_HANDLE = Symbol('DB_HANDLE');

/** The Drizzle database or an open transaction on it. */
export type DbExecutor = PgDatabase<NodePgQueryResultHKT, Schema>;

@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB_HANDLE) private readonly handle: DatabaseHandle) {}

  /** Runs after the gateways and pg-boss stopped (they stop in earlier shutdown phases). */
  async onApplicationShutdown(): Promise<void> {
    await this.handle.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB_HANDLE,
      inject: [AppConfig],
      // Migrations run while the provider is created, i.e. before anything can query the database.
      useFactory: async (config: AppConfig): Promise<DatabaseHandle> => {
        const handle = createDatabase(config.databaseUrl);
        if (config.runMigrations) await runMigrations(handle.db);
        return handle;
      },
    },
    { provide: DB, inject: [DB_HANDLE], useFactory: (handle: DatabaseHandle): Database => handle.db },
    { provide: PG_POOL, inject: [DB_HANDLE], useFactory: (handle: DatabaseHandle): pg.Pool => handle.pool },
    DbLifecycle,
  ],
  exports: [DB, PG_POOL],
})
export class DbModule {}
