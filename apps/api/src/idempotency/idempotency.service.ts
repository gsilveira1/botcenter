import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppError } from '../common/errors/app-error';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** A stored response is replayed for 24 h. Then the key is free and the maintenance queue deletes the row. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
/** A request in progress holds the key for this time. After it, a new request can take the key over. */
export const IDEMPOTENCY_LOCK_MS = 60_000;

export type IdempotencyStart =
  { kind: 'execute'; id: string } | { kind: 'replay'; status: number; body: unknown };

/** JSON with sorted object keys, so that the same body in a different key order has the same hash. */
export function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** SHA-256 of the method, the path with the query, and the body. */
export function requestHash(method: string, url: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${url}\n${stableStringify(body)}`)
    .digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * The store of `Idempotency-Key` (table `idempotency_keys`, scope: tenant + key).
 * `start` inserts a locked row, or returns the stored response, or refuses the request:
 * - same key, different request hash: 409 `IDEMPOTENCY_KEY_REUSED`;
 * - same key, request still in progress (`lockedUntil` in the future): 409 `IDEMPOTENCY_IN_PROGRESS`.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async start(
    tenantId: string,
    key: string,
    hash: string,
    now = new Date(),
  ): Promise<IdempotencyStart> {
    const db = this.prisma.forTenant(tenantId);
    // Two passes: the second pass runs after the delete of an expired row or a concurrent delete.
    for (let pass = 0; pass < 2; pass += 1) {
      try {
        const row = await db.idempotencyKey.create({
          data: {
            tenantId,
            key,
            requestHash: hash,
            lockedUntil: new Date(now.getTime() + IDEMPOTENCY_LOCK_MS),
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
          },
          select: { id: true },
        });
        return { kind: 'execute', id: row.id };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
      const existing = await db.idempotencyKey.findUnique({
        where: { tenantId_key: { tenantId, key } },
      });
      if (!existing) {
        continue;
      }
      if (existing.expiresAt <= now) {
        await db.idempotencyKey.deleteMany({ where: { id: existing.id, expiresAt: { lte: now } } });
        continue;
      }
      if (existing.requestHash !== hash) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          'The Idempotency-Key was already used with a different request',
        );
      }
      if (existing.responseStatus !== null) {
        return { kind: 'replay', status: existing.responseStatus, body: existing.responseBody };
      }
      if (existing.lockedUntil && existing.lockedUntil > now) {
        throw inProgress();
      }
      // The first request stopped without a response (crash). Take the key over atomically.
      const claimed = await db.idempotencyKey.updateMany({
        where: {
          id: existing.id,
          responseStatus: null,
          OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
        },
        data: { lockedUntil: new Date(now.getTime() + IDEMPOTENCY_LOCK_MS) },
      });
      if (claimed.count === 1) {
        return { kind: 'execute', id: existing.id };
      }
      throw inProgress();
    }
    throw inProgress();
  }

  async complete(tenantId: string, id: string, status: number, body: unknown): Promise<void> {
    await this.prisma.forTenant(tenantId).idempotencyKey.update({
      where: { id },
      data: {
        responseStatus: status,
        responseBody:
          body === undefined || body === null ? Prisma.JsonNull : (body as Prisma.InputJsonValue),
        lockedUntil: null,
      },
    });
  }

  /** Frees the key after a failed request, so that the client can retry with the same key. */
  async abandon(tenantId: string, id: string): Promise<void> {
    await this.prisma
      .forTenant(tenantId)
      .idempotencyKey.deleteMany({ where: { id, responseStatus: null } });
  }
}

function inProgress(): AppError {
  return new AppError(
    'IDEMPOTENCY_IN_PROGRESS',
    'A request with this Idempotency-Key is in progress. Retry later.',
    { headers: { 'Retry-After': '1' } },
  );
}
