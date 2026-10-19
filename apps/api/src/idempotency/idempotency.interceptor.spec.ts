import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { AlertService } from '../services/alert.service';
import { IdempotencyInterceptor, SkipIdempotency } from './idempotency.interceptor';
import type { IdempotencyService, IdempotencyStart } from './idempotency.service';

class Routes {
  normal() {}
  @SkipIdempotency() skipped() {}
}

function setup(
  start: IdempotencyStart,
  request: Record<string, unknown> = {},
  handler: keyof Routes = 'normal',
) {
  const store = {
    start: vi.fn(async () => start),
    complete: vi.fn(async () => undefined),
    abandon: vi.fn(async () => undefined),
  };
  const alerts = { notify: vi.fn(async () => undefined) };
  const reply = { statusCode: 201, status: vi.fn(), header: vi.fn() };
  reply.status.mockReturnValue(reply);
  reply.header.mockReturnValue(reply);
  const fullRequest = {
    method: 'POST',
    url: '/v1/messages',
    body: { a: 1 },
    headers: { 'idempotency-key': 'k-1' },
    auth: { tenantId: 't', keyId: 'key-a' },
    ...request,
  };
  const context = {
    getType: () => 'http',
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => fullRequest, getResponse: () => reply }),
  } as unknown as ExecutionContext;
  const interceptor = new IdempotencyInterceptor(
    store as unknown as IdempotencyService,
    new Reflector(),
    alerts as unknown as AlertService,
  );
  return { interceptor, store, reply, context, alerts };
}

const next = (value: unknown): CallHandler => ({ handle: () => of(value) });

describe('IdempotencyInterceptor', () => {
  it('stores the response of the first request', async () => {
    const { interceptor, store, reply, context } = setup({ kind: 'execute', id: 'row' });
    await expect(lastValueFrom(interceptor.intercept(context, next({ id: 'm' })))).resolves.toEqual(
      { id: 'm' },
    );
    expect(store.complete).toHaveBeenCalledWith('t', 'row', 201, { id: 'm' });
    expect(reply.header).toHaveBeenCalledWith('Idempotency-Replayed', 'false');
  });

  it('replays the stored status and body without the handler', async () => {
    const { interceptor, reply, context } = setup({
      kind: 'replay',
      status: 202,
      body: { id: 'old' },
    });
    const handle = vi.fn(() => of('new'));
    await expect(lastValueFrom(interceptor.intercept(context, { handle }))).resolves.toEqual({
      id: 'old',
    });
    expect(handle).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(202);
  });

  it('frees the key when the handler fails and passes the error on', async () => {
    const { interceptor, store, context } = setup({ kind: 'execute', id: 'row' });
    const failing: CallHandler = { handle: () => throwError(() => new Error('boom')) };
    await expect(lastValueFrom(interceptor.intercept(context, failing))).rejects.toThrow('boom');
    expect(store.abandon).toHaveBeenCalledWith('t', 'row');
  });

  it('keeps the response when the store fails after the action, and alerts', async () => {
    const { interceptor, store, context, alerts } = setup({ kind: 'execute', id: 'row' });
    store.complete.mockRejectedValueOnce(new Error('db down'));
    await expect(lastValueFrom(interceptor.intercept(context, next({ id: 'm' })))).resolves.toEqual(
      { id: 'm' },
    );
    expect(alerts.notify).toHaveBeenCalled();
  });

  it.each([
    ['no header', { headers: {} }, 'normal'],
    ['GET', { method: 'GET' }, 'normal'],
    ['PATCH', { method: 'PATCH' }, 'normal'],
    ['not /v1', { url: '/internal/evolution/webhook' }, 'normal'],
    ['no auth', { auth: undefined }, 'normal'],
    ['skipped route', {}, 'skipped'],
  ] as const)('passes through for %s', async (_name, request, handler) => {
    const { interceptor, store, context } = setup({ kind: 'execute', id: 'row' }, request, handler);
    await expect(lastValueFrom(interceptor.intercept(context, next('x')))).resolves.toBe('x');
    expect(store.start).not.toHaveBeenCalled();
  });

  it('refuses a key with control characters (400)', () => {
    const { interceptor, context } = setup(
      { kind: 'execute', id: 'row' },
      { headers: { 'idempotency-key': 'a b' } },
    );
    expect(() => interceptor.intercept(context, next('x'))).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('scopes the stored response to the API key, so a second key never gets the replay (SEC-09)', async () => {
    const first = setup({ kind: 'execute', id: 'row' });
    await lastValueFrom(first.interceptor.intercept(first.context, next({ id: 'm' })));
    const second = setup(
      { kind: 'execute', id: 'row-2' },
      { auth: { tenantId: 't', keyId: 'key-b' } },
    );
    await lastValueFrom(second.interceptor.intercept(second.context, next({ id: 'n' })));
    const firstKey = (first.store.start.mock.calls[0] as unknown as string[])[1];
    const secondKey = (second.store.start.mock.calls[0] as unknown as string[])[1];
    expect(firstKey).toBe('key-a:k-1');
    expect(secondKey).toBe('key-b:k-1');
  });
});
