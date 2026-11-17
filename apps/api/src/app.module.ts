import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AppConfig, ConfigModule } from './config/env.js';
import { ContextModule } from './context/context.module.js';
import { DbModule } from './db/db.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { PersonasModule } from './personas/personas.module.js';
import { PlanningModule } from './planning/planning.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { ReviewModule } from './review/review.module.js';
import { RunnersModule } from './runners/runners.module.js';
import { RunsModule } from './runs/runs.module.js';
import { TicketsModule } from './tickets/tickets.module.js';
import { UsageModule } from './usage/usage.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          // Session cookies and runner/pairing tokens must never reach the logs.
          redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
          ...(config.nodeEnv === 'development'
            ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
            : {}),
        },
      }),
    }),
    DbModule,
    AuthModule,
    AuditModule,
    JobsModule,
    RealtimeModule,
    WorkspacesModule,
    RunnersModule,
    ProjectsModule,
    TicketsModule,
    RunsModule,
    ReviewModule,
    PersonasModule,
    ContextModule,
    UsageModule,
    WorkflowsModule,
    PlanningModule,
  ],
})
export class AppModule {}
