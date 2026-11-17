import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { ApiException } from '../common/api-error.js';
import type { Permission } from './access.js';
import type { AuthSession } from './auth.js';
import type { AppRequest, AuthUser, WorkspaceContext } from './request-context.js';

export const IS_PUBLIC = 'coffe:public';
export const REQUIRED_PERMISSION = 'coffe:permission';

/** Opts a route out of the global `SessionGuard`. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Role permission (architecture §6.3) checked by `WorkspaceGuard` on top of membership. */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRED_PERMISSION, permission);

function sessionOf(context: ExecutionContext): AuthSession {
  const { auth } = context.switchToHttp().getRequest<AppRequest>();
  if (!auth) throw ApiException.unauthenticated();
  return auth;
}

export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthSession => sessionOf(context),
);

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => sessionOf(context).user,
);

/** Requires `WorkspaceGuard` on the route (it resolves `:ws` and the caller's role). */
export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, context: ExecutionContext): WorkspaceContext => {
    const { workspace } = context.switchToHttp().getRequest<AppRequest>();
    if (!workspace) throw ApiException.forbidden('Workspace context is missing');
    return workspace;
  },
);
