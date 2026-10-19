import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AlertService } from '../../services/alert.service';
import { AppError } from './app-error';
import { ProblemDetailsFilter } from './problem-details.filter';

function host(sent = false) {
  const reply = { sent, header: vi.fn(), status: vi.fn(), type: vi.fn(), send: vi.fn() };
  reply.status.mockReturnValue(reply);
  reply.type.mockReturnValue(reply);
  const request = { id: 'req-1', url: '/v1/x', method: 'GET', routeOptions: { url: '/v1/x' } };
  const argumentsHost = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as unknown as ArgumentsHost;
  return { argumentsHost, reply };
}

describe('ProblemDetailsFilter', () => {
  it('sends application/problem+json with the headers of the error', () => {
    const alerts = { notify: vi.fn() };
    const { argumentsHost, reply } = host();
    new ProblemDetailsFilter(alerts as unknown as AlertService).catch(
      new AppError('RATE_LIMITED', 'x', { headers: { 'Retry-After': '5' } }),
      argumentsHost,
    );
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '5');
    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.type).toHaveBeenCalledWith('application/problem+json');
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it('alerts on an unexpected error and does not send a second response', () => {
    const alerts = { notify: vi.fn() };
    const { argumentsHost, reply } = host(true);
    new ProblemDetailsFilter(alerts as unknown as AlertService).catch(
      new Error('x'),
      argumentsHost,
    );
    expect(alerts.notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical', dedupeKey: 'http:GET:/v1/x:500' }),
    );
    expect(reply.send).not.toHaveBeenCalled();
  });
});
