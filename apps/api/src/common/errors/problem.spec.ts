import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ProblemDetails } from '@botcenter/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from './app-error';
import { toProblem } from './problem';

const request = { id: 'req-1', url: '/v1/messages?x=1' };

describe('toProblem', () => {
  it('maps an AppError with its status, type, field errors, and headers', () => {
    const output = toProblem(
      new AppError('RATE_LIMITED', 'Slow down', { headers: { 'Retry-After': '3' } }),
      request,
    );
    expect(output).toMatchObject({
      status: 429,
      headers: { 'Retry-After': '3' },
      unexpected: false,
    });
    expect(output.body).toEqual({
      type: 'urn:botcenter:problem:rate-limited',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Slow down',
      code: 'RATE_LIMITED',
      instance: '/v1/messages',
      request_id: 'req-1',
    });
    expect(ProblemDetails.safeParse(output.body).success).toBe(true);
    const validation = toProblem(
      new AppError('VALIDATION_FAILED', 'Bad', { errors: [{ path: 'to', message: 'Required' }] }),
      request,
    );
    expect(validation.body.errors).toEqual([{ path: 'to', message: 'Required' }]);
  });

  it('maps a Nest HttpException by status and hides the detail of a 5xx', () => {
    expect(toProblem(new NotFoundException('Cannot GET /x'), request).body).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    const unavailable = toProblem(new ServiceUnavailableException('db password=x'), request);
    expect(unavailable.body).toMatchObject({
      status: 503,
      code: 'PROVIDER_UNAVAILABLE',
      detail: 'Internal error',
    });
    expect(unavailable.unexpected).toBe(true);
  });

  it('maps a Fastify client error (body too large) by its status code', () => {
    const error = Object.assign(new Error('Request body is too large'), {
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });
    expect(toProblem(error, request)).toMatchObject({
      status: 413,
      body: { code: 'VALIDATION_FAILED' },
      unexpected: false,
    });
  });

  it('maps any other value to 500 INTERNAL without its message', () => {
    const output = toProblem(new Error('connection string postgresql://user:secret@db'), {});
    expect(output).toMatchObject({
      status: 500,
      unexpected: true,
      body: { code: 'INTERNAL', detail: 'Internal error' },
    });
    expect(output.body).not.toHaveProperty('instance');
    expect(toProblem('text', {}).status).toBe(500);
  });
});
