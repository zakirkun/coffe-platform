import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

export interface DatabaseHandle {
  pool: pg.Pool;
  db: Database;
}

/** One node-postgres pool shared by Drizzle, Better Auth and pg-boss. */
export function createDatabase(url: string, max = 20): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: url, max });
  return { pool, db: drizzle(pool, { schema, casing: 'snake_case' }) };
}
