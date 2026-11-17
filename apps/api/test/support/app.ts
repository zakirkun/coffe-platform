import { createServer } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql } from 'drizzle-orm';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap.js';
import type { Database } from '../../src/db/client.js';
import { DB } from '../../src/db/db.module.js';

const DEFAULT_TEST_DATABASE_URL = 'postgres://coffe:coffe@localhost:55432/coffe_test';
const HOST = '127.0.0.1';

/** The real application (same bootstrap as `main.ts`) listening on a free local port. */
export interface TestApp {
  app: INestApplication;
  /** `http://127.0.0.1:<port>`; also the trusted browser origin. */
  baseUrl: string;
  /** `ws://127.0.0.1:<port>`; append `/api/ws` or `/api/runner`. */
  wsBase: string;
  db: Database;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, HOST, () => {
    const address = probe.address();
    probe.close(() => {
      if (address !== null && typeof address === 'object') resolve(address.port);
      else reject(new Error('could not determine a free port'));
    });
  });
  return promise;
}

/**
 * Boots the control plane against the test database (`TEST_DATABASE_URL`, migrated at startup).
 * The port is chosen first because the public URL and trusted origins are part of the
 * configuration the application reads while it is created.
 */
export async function startTestApp(): Promise<TestApp> {
  const port = await freePort();
  const baseUrl = `http://${HOST}:${port}`;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
    AUTH_SECRET: 'test-only-secret-0123456789abcdef0123456789',
    RUN_MIGRATIONS: 'true',
    PORT: String(port),
    LOG_LEVEL: 'silent',
    PUBLIC_URL: baseUrl,
    RUNNER_PUBLIC_URL: baseUrl,
    TRUSTED_ORIGINS: baseUrl,
    RUNNER_MIN_VERSION: '0.1.0',
    PROTOCOL_MIN_MINOR: '0',
  });

  // `abortOnError: false`: a failing bootstrap must fail the test instead of exiting the worker.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    bufferLogs: true,
    abortOnError: false,
  });
  configureApp(app);
  await app.listen(port, HOST);

  return {
    app,
    baseUrl,
    wsBase: `ws://${HOST}:${port}`,
    db: app.get<Database>(DB),
    close: () => app.close(),
  };
}

/** Empties every table of the public schema; the migration bookkeeping is kept. */
export async function resetDatabase(db: Database): Promise<void> {
  const result = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables
        where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  if (result.rows.length === 0) return;
  const tables = result.rows
    .map((row) => `"public"."${row.tablename.replaceAll('"', '""')}"`)
    .join(', ');
  await db.execute(sql.raw(`truncate table ${tables} restart identity cascade`));
}
