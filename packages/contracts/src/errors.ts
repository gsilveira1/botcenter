import { z } from 'zod';

/** Stable error codes of the public API. Clients use `code`, not `title` or `detail`. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'SCOPE_MISSING',
  'INSTANCE_NOT_ALLOWED',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_IN_PROGRESS',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'INSTANCE_NOT_CONNECTED',
  'CONNECT_TOKEN_INVALID',
  'BOT_DEFINITION_INVALID',
  'WEBHOOK_URL_FORBIDDEN',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL',
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** HTTP status for each error code. The Problem Details filter of the API uses this table. */
export const ERROR_HTTP_STATUS = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  SCOPE_MISSING: 403,
  INSTANCE_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  INSTANCE_NOT_CONNECTED: 409,
  CONNECT_TOKEN_INVALID: 401,
  BOT_DEFINITION_INVALID: 422,
  WEBHOOK_URL_FORBIDDEN: 422,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const satisfies Record<ErrorCode, number>;

/** Prefix of the Problem Details `type` URI. */
export const PROBLEM_TYPE_PREFIX = 'urn:botcenter:problem:';

/** Returns the Problem Details `type` URI of an error code (`urn:botcenter:problem:not-found`). */
export function problemType(code: ErrorCode): string {
  return `${PROBLEM_TYPE_PREFIX}${code.toLowerCase().replaceAll('_', '-')}`;
}

/** Media type of an error response. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** One validation issue. `path` is a dot path to the field (`definition.states.start.transitions.0.target`). */
export const ProblemFieldError = z.object({
  path: z.string(),
  message: z.string(),
});
export type ProblemFieldError = z.infer<typeof ProblemFieldError>;

/** RFC 9457 Problem Details with the stable `code` of Bot Center. */
export const ProblemDetails = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  code: ErrorCode,
  instance: z.string().optional(),
  request_id: z.string().optional(),
  errors: z.array(ProblemFieldError).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;
