import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiException } from '../common/api-error.js';
import { type Permission, roleAllows } from './access.js';
import { REQUIRED_PERMISSION } from './decorators.js';
import { MembershipService } from './membership.service.js';
import type { AppRequest } from './request-context.js';

/**
 * Controller guard for `/workspaces/:ws/...` routes: the caller must be a member of `:ws`
 * (403 otherwise) and hold the `@RequirePermission()` of the route, if any. Attaches
 * `request.workspace = { id, role }`.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    private readonly memberships: MembershipService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const workspaceId = request.params.ws;
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      throw ApiException.forbidden('Workspace is required');
    }
    if (!request.auth) throw ApiException.unauthenticated();

    const role = await this.memberships.roleOf(request.auth.user.id, workspaceId);
    if (!role) throw ApiException.forbidden('You are not a member of this workspace');

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(
      REQUIRED_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (permission && !roleAllows(role, permission)) {
      throw ApiException.forbidden(`Your role (${role}) is not allowed to do this`);
    }
    request.workspace = { id: workspaceId, role };
    return true;
  }
}
