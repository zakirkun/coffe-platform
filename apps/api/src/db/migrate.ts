import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client.js';

/** `apps/api/drizzle`, resolved from both `src/db` (tests) and `dist/db` (built). */
export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
