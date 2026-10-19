import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  IDEMPOTENCY_LOCK_MS,
  IdempotencyService,
  requestHash,
  stableStringify,
} from './idempotency.service';

describe('request hash', () => {
  it('ignores the key order and undefined values', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}');
    expect(requestHash('post', '/v1/x', { a: 1, b: 2 })).toBe(
      requestHash('POST', '/v1/x', { b: 2, a: 1 }),
    );
  });

  it('changes with the method, the URL, and the body', () => {
    const base = requestHash('POST', '/v1/x', { a: 1 });
    expect(requestHash('PUT', '/v1/x', { a: 1 })).not.toBe(base);
    expect(requestHash('POST', '/v1/x?y=1', { a: 1 })).not.toBe(base);
    expect(requestHash('POST', '/v1/x', { a: 2 })).not.toBe(base);
  });
});

const now = new Date('2026-10-19T10:00:00.000Z');
const unique = () =>
  new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });

function build(existing: Record<string, unknown> | null, claimed = 1) {
  const delegate = {
    create: vi.fn(async () => Promise.reject(unique())),
    findUnique: vi.fn(async () => existing),
    deleteMany: vi.fn(async () => ({ count: 1 })),
    updateMany: vi.fn(async () => ({ count: claimed })),
  };
  const prisma = { forTenant: () => ({ idempotencyKey: delegate }) } as unknown as PrismaService;
  return { service: new IdempotencyService(prisma), delegate };
}

const row = (overrides: Record<string, unknown>) => ({
  id: 'row-1',
  requestHash: 'h',
  responseStatus: null,
  responseBody: null,
  lockedUntil: new Date(now.getTime() + IDEMPOTENCY_LOCK_MS),
  expiresAt: new Date(now.getTime() + 1000),
  ...overrides,
});

describe('IdempotencyService.start', () => {
  it('executes when the insert succeeds', async () => {
    const { service, delegate } = build(null);
    delegate.create.mockResolvedValueOnce({ id: 'new' } as never);
    await expect(service.start('t', 'k', 'h', now)).resolves.toEqual({
      kind: 'execute',
      id: 'new',
    });
  });

  it('replays a stored response', async () => {
    const { service } = build(row({ responseStatus: 202, responseBody: { id: 'm' } }));
    await expect(service.start('t', 'k', 'h', now)).resolves.toEqual({
      kind: 'replay',
      status: 202,
      body: { id: 'm' },
    });
  });

  it('refuses a different request hash and a request in progress', async () => {
    await expect(
      build(row({ requestHash: 'other' })).service.start('t', 'k', 'h', now),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    await expect(build(row({})).service.start('t', 'k', 'h', now)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });
  });

  it('takes over a stale lock atomically', async () => {
    const stale = row({ lockedUntil: new Date(now.getTime() - 1) });
    await expect(build(stale).service.start('t', 'k', 'h', now)).resolves.toEqual({
      kind: 'execute',
      id: 'row-1',
    });
    await expect(build(stale, 0).service.start('t', 'k', 'h', now)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });
  });

  it('deletes an expired row and inserts again', async () => {
    const { service, delegate } = build(row({ expiresAt: new Date(now.getTime() - 1) }));
    delegate.create.mockRejectedValueOnce(unique()).mockResolvedValueOnce({ id: 'fresh' } as never);
    await expect(service.start('t', 'k', 'h', now)).resolves.toEqual({
      kind: 'execute',
      id: 'fresh',
    });
    expect(delegate.deleteMany).toHaveBeenCalled();
  });

  it('passes a different database error through', async () => {
    const { service, delegate } = build(null);
    delegate.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(service.start('t', 'k', 'h', now)).rejects.toThrow('connection lost');
  });
});
