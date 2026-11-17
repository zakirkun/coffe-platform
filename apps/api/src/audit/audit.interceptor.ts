import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { mergeMap, type Observable } from 'rxjs';
import type { AppRequest } from '../auth/request-context.js';
import { AuditService } from './audit.service.js';

const AUDIT_META = 'coffe:audit';
const MAX_STRING = 8 * 1024;

interface AuditMeta {
  action: string;
  targetType?: string;
  targetParam?: string;
}

/**
 * Marks a mutating REST handler as audited: after it succeeds, `AuditInterceptor` records the
 * acting user, the request body and the target. The target id is the route parameter
 * `targetParam`, or the `id` of the response body when omitted.
 */
export const Audit = (action: string, targetType?: string, targetParam?: string) =>
  SetMetadata(AUDIT_META, { action, targetType, targetParam } satisfies AuditMeta);

/** Request body as stored in `audit_logs.details`: long strings cut, large structures omitted. */
export function auditableBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') {
      result[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [truncated]` : value;
    } else if (typeof value === 'object' && value !== null) {
      result[key] = JSON.stringify(value).length > MAX_STRING ? '[omitted: too large]' : value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function responseId(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || !('id' in result)) return null;
  return typeof result.id === 'string' ? result.id : null;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMeta | undefined>(AUDIT_META, context.getHandler());
    if (!meta || context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<AppRequest>();

    return next.handle().pipe(
      mergeMap(async (result: unknown) => {
        const { ws: _ws, ...params } = request.params;
        let targetId = responseId(result);
        if (meta.targetParam) {
          const param = request.params[meta.targetParam];
          targetId = typeof param === 'string' ? param : null;
        }
        await this.audit.record({
          workspaceId: request.workspace?.id ?? null,
          actorType: 'user',
          actorUserId: request.auth?.user.id ?? null,
          action: meta.action,
          targetType: meta.targetType ?? null,
          targetId,
          runId: meta.targetType === 'run' ? targetId : null,
          details: { params, body: auditableBody(request.body) },
          ip: request.ip ?? null,
          userAgent: request.headers['user-agent'] ?? null,
        });
        return result;
      }),
    );
  }
}
