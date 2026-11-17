import { Global, Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppConfig } from '../config/env.js';
import type { Database } from '../db/client.js';
import { DB } from '../db/db.module.js';
import {
  account,
  invitation,
  member,
  organization,
  session,
  user,
  verification,
} from '../db/schema/index.js';
import { type CoffeAuth, createAuth } from './auth.js';
import { AUTH } from './auth.tokens.js';
import { MembershipService } from './membership.service.js';
import { SessionGuard } from './session.guard.js';
import { WorkspaceGuard } from './workspace.guard.js';

@Global()
@Module({
  providers: [
    {
      provide: AUTH,
      inject: [DB, AppConfig],
      useFactory: (db: Database, config: AppConfig): CoffeAuth => {
        const logger = new Logger('Auth');
        return createAuth({
          db,
          schema: { user, session, account, verification, organization, member, invitation },
          baseURL: config.publicUrl,
          secret: config.authSecret,
          trustedOrigins: [...config.trustedOrigins],
          onInvitation: (notice) => {
            logger.log(
              `invitation for ${notice.email} to "${notice.organizationName}" (${notice.role}): ${notice.url}`,
            );
          },
        });
      },
    },
    MembershipService,
    WorkspaceGuard,
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [AUTH, MembershipService, WorkspaceGuard],
})
export class AuthModule {}
