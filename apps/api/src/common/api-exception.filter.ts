import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import type { ApiError } from '@coffe/contracts';
import type { Response } from 'express';
import { ApiException } from './api-error.js';

const CODES_BY_STATUS: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable_entity',
  429: 'too_many_requests',
  503: 'service_unavailable',
};

const BODY_PARSER_CODES: Record<string, string> = {
  'entity.parse.failed': 'invalid_json',
  'entity.too.large': 'payload_too_large',
  'encoding.unsupported': 'unsupported_media_type',
  'charset.unsupported': 'unsupported_media_type',
};

interface RenderedError {
  status: number;
  body: ApiError;
}

function httpExceptionMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const { message } = response;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('; ');
  }
  return exception.message;
}

/** Client errors raised by Express middleware (`http-errors` shape, e.g. the JSON body parser). */
function exposedClientError(error: unknown): { status: number; type: string | null } | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { status?: unknown; expose?: unknown; type?: unknown };
  if (typeof candidate.status !== 'number' || candidate.status < 400 || candidate.status > 499) {
    return null;
  }
  if (candidate.expose !== true) return null;
  return { status: candidate.status, type: typeof candidate.type === 'string' ? candidate.type : null };
}

export function renderError(exception: unknown): RenderedError {
  if (exception instanceof ApiException) {
    return {
      status: exception.getStatus(),
      body: {
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.details ? { details: exception.details } : {}),
        },
      },
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = CODES_BY_STATUS[status] ?? (status >= 500 ? 'internal_error' : 'request_failed');
    const message = status >= 500 ? 'Internal server error' : httpExceptionMessage(exception);
    return { status, body: { error: { code, message } } };
  }
  const clientError = exposedClientError(exception);
  if (clientError) {
    const code =
      (clientError.type ? BODY_PARSER_CODES[clientError.type] : undefined) ??
      CODES_BY_STATUS[clientError.status] ??
      'request_failed';
    const message = exception instanceof Error ? exception.message : 'Request failed';
    return { status: clientError.status, body: { error: { code, message } } };
  }
  return {
    status: 500,
    body: { error: { code: 'internal_error', message: 'Internal server error' } },
  };
}

/** Renders every error as the contracts `ApiError` body. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body } = renderError(exception);
    if (status >= 500) {
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
      );
    }
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    response.status(status).json(body);
  }
}

/** Global pipe: zod / Standard Schema issues become `400 validation_failed`. */
export function createValidationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    exceptionFactory: (issues) =>
      ApiException.badRequest('validation_failed', 'Request validation failed', {
        issues: issues.map((issue) => ({
          path: (issue.path ?? [])
            .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
            .join('.'),
          message: issue.message,
        })),
      }),
  });
}
