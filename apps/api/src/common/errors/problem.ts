import { STATUS_CODES } from 'node:http';
import { HttpException } from '@nestjs/common';
import { ERROR_HTTP_STATUS, PROBLEM_CONTENT_TYPE, problemType } from '@botcenter/contracts';
import type { ErrorCode, ProblemDetails } from '@botcenter/contracts';
import { AppError } from './app-error';

export { PROBLEM_CONTENT_TYPE };

/** Error code of an HTTP status that has no `AppError` (Nest exceptions, Fastify errors). */
const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'VALIDATION_FAILED',
  415: 'VALIDATION_FAILED',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  503: 'PROVIDER_UNAVAILABLE',
};

export interface ProblemRequest {
  id?: string;
  url?: string;
}

export interface ProblemOutput {
  status: number;
  body: ProblemDetails;
  headers: Record<string, string>;
  /** True for an unexpected error (5xx). The filter logs it with the stack and sends an alert. */
  unexpected: boolean;
}

/** A Fastify error (body too large, malformed JSON, unsupported media type) has `statusCode`. */
interface FastifyLikeError {
  statusCode?: unknown;
  code?: unknown;
  message?: unknown;
}

function codeForStatus(status: number): ErrorCode {
  return CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED');
}

function titleOf(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}

function build(
  status: number,
  code: ErrorCode,
  detail: string,
  request: ProblemRequest,
): ProblemDetails {
  const body: ProblemDetails = {
    type: problemType(code),
    title: titleOf(status),
    status,
    detail,
    code,
  };
  const path = request.url?.split('?')[0];
  if (path) {
    body.instance = path;
  }
  if (request.id) {
    body.request_id = request.id;
  }
  return body;
}

function httpExceptionDetail(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') {
    return response;
  }
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) {
    return message.map(String).join('; ');
  }
  return typeof message === 'string' ? message : exception.message;
}

/**
 * Pure mapping from any thrown value to an RFC 9457 Problem Details document.
 * The detail of an unexpected error never goes to the client.
 */
export function toProblem(exception: unknown, request: ProblemRequest): ProblemOutput {
  if (exception instanceof AppError) {
    const status = ERROR_HTTP_STATUS[exception.code];
    const body = build(status, exception.code, exception.detail, request);
    if (exception.errors) {
      body.errors = exception.errors;
    }
    return { status, body, headers: exception.headers, unexpected: status >= 500 };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const unexpected = status >= 500;
    const detail = unexpected ? 'Internal error' : httpExceptionDetail(exception);
    return {
      status,
      body: build(status, codeForStatus(status), detail, request),
      headers: {},
      unexpected,
    };
  }

  const fastifyError = exception as FastifyLikeError | null;
  if (
    fastifyError &&
    typeof fastifyError.statusCode === 'number' &&
    fastifyError.statusCode >= 400 &&
    fastifyError.statusCode < 500 &&
    typeof fastifyError.code === 'string' &&
    fastifyError.code.startsWith('FST_')
  ) {
    const status = fastifyError.statusCode;
    const detail = typeof fastifyError.message === 'string' ? fastifyError.message : 'Bad request';
    return {
      status,
      body: build(status, codeForStatus(status), detail, request),
      headers: {},
      unexpected: false,
    };
  }

  return {
    status: 500,
    body: build(500, 'INTERNAL', 'Internal error', request),
    headers: {},
    unexpected: true,
  };
}
