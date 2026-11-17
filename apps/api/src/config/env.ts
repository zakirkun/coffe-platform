import { Global, Module } from '@nestjs/common';
import { z } from 'zod';

const booleanFlag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const originUrl = z.url().transform((v) => v.replace(/\/+$/, ''));

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(4000),
  DATABASE_URL: z.string().min(1),
  /** Browser origin: Better Auth base URL and the default trusted origin. */
  PUBLIC_URL: originUrl,
  /** Server URL printed in the runner pairing command; defaults to PUBLIC_URL. */
  RUNNER_PUBLIC_URL: originUrl.optional(),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  /** Comma-separated browser origins allowed for auth and the realtime socket. */
  TRUSTED_ORIGINS: z.string().optional(),
  RUNNER_MIN_VERSION: z
    .string()
    .regex(/^\d+\.\d+\.\d+/, 'RUNNER_MIN_VERSION must be a semver version')
    .default('0.1.0'),
  PROTOCOL_MIN_MINOR: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RUN_MIGRATIONS: booleanFlag.default(true),
});

/** Validated process configuration, injectable everywhere (`ConfigModule` is global). */
export class AppConfig {
  constructor(
    readonly nodeEnv: 'development' | 'test' | 'production',
    readonly port: number,
    readonly databaseUrl: string,
    readonly publicUrl: string,
    readonly runnerPublicUrl: string,
    readonly authSecret: string,
    readonly trustedOrigins: readonly string[],
    readonly runnerMinVersion: string,
    readonly protocolMinMinor: number,
    readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent',
    readonly runMigrations: boolean,
  ) {}
}

/** Parses and validates the environment; throws one readable error listing every problem. */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const defined = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = EnvSchema.safeParse(defined);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(env)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const e = parsed.data;
  const extraOrigins = (e.TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0);
  const trustedOrigins = [...new Set([e.PUBLIC_URL, ...extraOrigins])];
  return new AppConfig(
    e.NODE_ENV,
    e.PORT,
    e.DATABASE_URL,
    e.PUBLIC_URL,
    e.RUNNER_PUBLIC_URL ?? e.PUBLIC_URL,
    e.AUTH_SECRET,
    trustedOrigins,
    e.RUNNER_MIN_VERSION,
    e.PROTOCOL_MIN_MINOR,
    e.LOG_LEVEL,
    e.RUN_MIGRATIONS,
  );
}

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => loadConfig(process.env) }],
  exports: [AppConfig],
})
export class ConfigModule {}
