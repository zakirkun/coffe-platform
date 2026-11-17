import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import { ApiException } from '../common/api-error.js';
import type { CoffeAuth } from './auth.js';
import { AUTH } from './auth.tokens.js';
import { IS_PUBLIC } from './decorators.js';
import type { AppRequest } from './request-context.js';

/** Global guard: every REST route needs a Better Auth session unless marked `@Public()`. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: CoffeAuth,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<AppRequest>();
    const session = await this.auth.getSession(fromNodeHeaders(request.headers));
    if (!session) throw ApiException.unauthenticated();
    request.auth = session;
    return true;
  }
}
