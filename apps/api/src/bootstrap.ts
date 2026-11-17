import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Logger } from 'nestjs-pino';
import type { CoffeAuth } from './auth/auth.js';
import { AUTH } from './auth/auth.tokens.js';
import { ApiExceptionFilter, createValidationPipe } from './common/api-exception.filter.js';
import { UpgradeRouter } from './realtime/upgrade-router.js';

export const REST_PREFIX = 'api/v1';
const AUTH_PATH_PREFIX = '/api/auth/';
const JSON_BODY_LIMIT = '5mb';

/**
 * Everything between `NestFactory.create(AppModule, { bodyParser: false, bufferLogs: true })`
 * and `listen()`, shared by `main.ts` and the test harness: logger, Better Auth at
 * `/api/auth/*`, JSON bodies, the `/api/v1` prefix, validation, error rendering, WebSocket
 * upgrades and shutdown hooks.
 */
export function configureApp(app: NestExpressApplication): void {
  app.useLogger(app.get(Logger));

  // Better Auth reads the raw request stream, so it is mounted before the JSON body parser.
  const auth = app.get<CoffeAuth>(AUTH);
  const authHandler = toNodeHandler((request) => auth.handler(request));
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!request.path.startsWith(AUTH_PATH_PREFIX)) {
      next();
      return;
    }
    authHandler(request, response).catch(next);
  });
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.setGlobalPrefix(REST_PREFIX);
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ApiExceptionFilter());
  app.get(UpgradeRouter).attach(app.getHttpServer());
  app.enableShutdownHooks();
}
