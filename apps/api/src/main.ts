import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { AppConfig } from './config/env.js';

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  bodyParser: false,
  bufferLogs: true,
});
configureApp(app);

const config = app.get(AppConfig);
await app.listen(config.port);
new Logger('Bootstrap').log(
  `COFFE control plane listening on ${await app.getUrl()} (public URL ${config.publicUrl}, runners connect to ${config.runnerPublicUrl})`,
);
