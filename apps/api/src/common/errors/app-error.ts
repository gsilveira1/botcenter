import { ERROR_HTTP_STATUS } from '@botcenter/contracts';
import type { ErrorCode, ProblemFieldError } from '@botcenter/contracts';

export interface AppErrorOptions {
  /** Field errors of a `VALIDATION_FAILED` problem. */
  errors?: ProblemFieldError[];
  /** Response headers, for example `Retry-After`. */
  headers?: Record<string, string>;
  cause?: unknown;
}

/**
 * An error with a stable code of the public API. The Problem Details filter maps it to
 * `application/problem+json` with the status of `ERROR_HTTP_STATUS[code]`.
 * `detail` goes to the client: never put a secret, a phone number, or message content in it.
 */
export class AppError extends Error {
  readonly errors: ProblemFieldError[] | undefined;
  readonly headers: Record<string, string>;

  constructor(
    readonly code: ErrorCode,
    readonly detail: string,
    options: AppErrorOptions = {},
  ) {
    super(detail, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.errors = options.errors;
    this.headers = options.headers ?? {};
  }

  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

export function validationError(detail: string, errors: ProblemFieldError[]): AppError {
  return new AppError('VALIDATION_FAILED', detail, { errors });
}

export function notFound(resource: string): AppError {
  return new AppError('NOT_FOUND', `${resource} not found`);
}
