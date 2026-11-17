import { createDatabase } from './client.js';
import { runMigrations } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const { pool, db } = createDatabase(url, 1);
try {
  await runMigrations(db);
  console.log('migrations applied');
} finally {
  await pool.end();
}
