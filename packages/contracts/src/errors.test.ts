import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  ErrorCode,
  ProblemDetails,
  problemType,
} from './errors.js';

describe('ErrorCode', () => {
  it('has an HTTP status for each code', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });

  it('refuses an unknown code', () => {
    expect(ErrorCode.safeParse('TEAPOT').success).toBe(false);
  });

  it('maps the codes of the plan to their statuses', () => {
    expect(ERROR_HTTP_STATUS.IDEMPOTENCY_KEY_REUSED).toBe(409);
    expect(ERROR_HTTP_STATUS.INSTANCE_NOT_ALLOWED).toBe(403);
    expect(ERROR_HTTP_STATUS.RATE_LIMITED).toBe(429);
    expect(ERROR_HTTP_STATUS.NOT_FOUND).toBe(404);
  });
});

describe('problemType', () => {
  it('builds a URN from the code', () => {
    expect(problemType('IDEMPOTENCY_KEY_REUSED')).toBe(
      'urn:botcenter:problem:idempotency-key-reused',
    );
  });
});

describe('ProblemDetails', () => {
  const valid = {
    type: problemType('VALIDATION_FAILED'),
    title: 'Validation failed',
    status: 400,
    detail: 'The request body is not valid',
    code: 'VALIDATION_FAILED',
    instance: '/v1/messages',
    request_id: 'req-1',
    errors: [{ path: 'to', message: 'Must be an E.164 number' }],
  };

  it('accepts a full problem', () => {
    expect(ProblemDetails.safeParse(valid).success).toBe(true);
  });

  it('accepts a problem without the optional fields', () => {
    const { instance: _i, request_id: _r, errors: _e, ...minimal } = valid;
    expect(ProblemDetails.safeParse(minimal).success).toBe(true);
  });

  it('refuses a status that is not an error', () => {
    expect(ProblemDetails.safeParse({ ...valid, status: 200 }).success).toBe(false);
  });

  it('refuses a problem without a code', () => {
    const { code: _c, ...withoutCode } = valid;
    expect(ProblemDetails.safeParse(withoutCode).success).toBe(false);
  });
});
