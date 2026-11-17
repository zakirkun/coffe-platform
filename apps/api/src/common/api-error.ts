import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Error with a stable machine code; rendered by `ApiExceptionFilter` as the contracts `ApiError`
 * body `{ error: { code, message, details? } }`.
 */
export class ApiException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message, status);
  }

  static badRequest(code: string, message: string, details?: Record<string, unknown>) {
    return new ApiException(HttpStatus.BAD_REQUEST, code, message, details);
  }

  static unauthenticated(message = 'Sign in required') {
    return new ApiException(HttpStatus.UNAUTHORIZED, 'unauthenticated', message);
  }

  static forbidden(message = 'You do not have access to this resource') {
    return new ApiException(HttpStatus.FORBIDDEN, 'forbidden', message);
  }

  static notFound(resource: string) {
    return new ApiException(HttpStatus.NOT_FOUND, 'not_found', `${resource} not found`);
  }

  static conflict(code: string, message: string, details?: Record<string, unknown>) {
    return new ApiException(HttpStatus.CONFLICT, code, message, details);
  }

  static runnerOffline() {
    return new ApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'runner_offline',
      'The runner is offline',
    );
  }
}
