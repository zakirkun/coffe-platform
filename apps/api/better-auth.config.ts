// Used only by `pnpm auth:schema` (Better Auth CLI) to generate the Drizzle auth tables.
import { drizzle } from 'drizzle-orm/node-postgres';
import { buildBetterAuth } from './src/auth/auth.ts';

export const auth = buildBetterAuth({
  db: drizzle.mock(),
  schema: {},
  baseURL: 'http://localhost:4000',
  secret: 'schema-generation-only-secret-0123456789',
  trustedOrigins: [],
});
