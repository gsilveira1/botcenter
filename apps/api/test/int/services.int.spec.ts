import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable, Module } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { QueuesService } from '../../src/queues/queues.service';
import { UnrecoverableError, WorkerFactory } from '../../src/queues/worker.factory';
import { QuotaService } from '../../src/rate-limit/quota.service';
import { AuditService } from '../../src/services/audit.service';
import { DistributedLockService, LockNotAcquiredError } from '../../src/services/lock.service';
import { OutboxPayloadError, OutboxService } from '../../src/services/outbox.service';
import { TenantsService } from '../../src/services/tenants.service';
import { CoreWorkerRoot } from '../support/core-worker-root';
import { TestHarness } from '../support/harness';

let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start();
});

afterAll(async () => {
  await h?.close();
});

function statusPayload(instanceId: string) {
  return {
    instance_id: instanceId,
    external_ref: 'trainer-1',
    message_id: randomUUID(),
    status: 'sent' as const,
    failure_reason: null,
  };
}

describe('OutboxService', () => {
  it('writes the event in the transaction of the caller: a rollback removes it', async () => {
    const tenant = await h.createTenant();
    const prisma = h.get(PrismaService);
    const outbox = h.get(OutboxService);
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.enqueue(tx, {
          tenantId: tenant.id,
          type: 'message.status',
          payload: statusPayload(randomUUID()),
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await h.prisma.outboxEvent.count({ where: { tenantId: tenant.id } })).toBe(0);

    const id = await prisma.$transaction((tx) =>
      outbox.enqueue(tx, {
        tenantId: tenant.id,
        type: 'message.status',
        payload: statusPayload(randomUUID()),
      }),
    );
    const row = await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ type: 'message.status', dispatchedAt: null });
  });

  it('refuses a payload that does not match the contracts and rolls the transaction back', async () => {
    const tenant = await h.createTenant();
    await expect(
      h.get(PrismaService).$transaction((tx) =>
        h.get(OutboxService).enqueue(tx, {
          tenantId: tenant.id,
          type: 'message.status',
          payload: { status: 'bad' } as never,
        }),
      ),
    ).rejects.toBeInstanceOf(OutboxPayloadError);
  });
});

describe('AuditService', () => {
  it('inserts a row; the database refuses an update and a delete', async () => {
    const id = await h.get(AuditService).record({
      tenantId: null,
      actor: 'system:test',
      action: 'test.action',
      targetType: 'test',
      metadata: { count: 1 },
    });
    expect(await h.prisma.auditLog.findUniqueOrThrow({ where: { id } })).toMatchObject({
      action: 'test.action',
    });
    await expect(
      h.prisma.auditLog.update({ where: { id }, data: { action: 'changed' } }),
    ).rejects.toThrow(/insert only/);
    await expect(h.prisma.auditLog.delete({ where: { id } })).rejects.toThrow(/insert only/);
  });
});

describe('PrismaService.forTenant', () => {
  it('adds the tenant filter to reads and the tenant id to creates', async () => {
    const [a, b] = [await h.createTenant(), await h.createTenant()];
    const instanceB = await h.createInstance(b.id);
    const db = h.get(PrismaService).forTenant(a.id);
    expect(await db.instance.findUnique({ where: { id: instanceB.id } })).toBeNull();
    expect(await db.instance.count()).toBe(0);
    const created = await db.instance.create({
      data: {
        tenantId: b.id,
        externalRef: 'x',
        providerName: `inst_${randomUUID()}`,
        consentAt: new Date(),
        rateLimitPerMinute: 10,
      },
    });
    expect(created.tenantId).toBe(a.id);
    const updated = await db.instance.updateMany({
      where: { id: instanceB.id },
      data: { host: 'other' },
    });
    expect(updated.count).toBe(0);
  });
});

describe('TenantsService', () => {
  it('caches the tenant and reads the new quotas after invalidate', async () => {
    const tenant = await h.createTenant({ maxMessagesPerDay: 10 });
    const service = h.get(TenantsService);
    expect((await service.get(tenant.id)).maxMessagesPerDay).toBe(10);
    await h.prisma.tenant.update({ where: { id: tenant.id }, data: { maxMessagesPerDay: 20 } });
    expect((await service.get(tenant.id)).maxMessagesPerDay).toBe(10);
    await service.invalidate(tenant.id);
    expect((await service.get(tenant.id)).maxMessagesPerDay).toBe(20);
    await expect(service.get(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('QuotaService', () => {
  it('counts in a fixed window, refuses above the limit, and gives an amount back', async () => {
    const quotas = h.get(QuotaService);
    const request = {
      name: 'messages-per-day',
      subject: randomUUID(),
      window: 'day' as const,
      limit: 2,
    };
    expect((await quotas.consume(request)).allowed).toBe(true);
    expect((await quotas.consume(request)).remaining).toBe(0);
    const refused = await quotas.consume(request);
    expect(refused).toMatchObject({ allowed: false, used: 2 });
    await quotas.refund(request);
    expect((await quotas.peek(request)).used).toBe(1);
  });
});

describe('DistributedLockService', () => {
  it('gives the lock to one holder and releases it only with its token', async () => {
    const locks = h.get(DistributedLockService);
    const name = `conversation:${randomUUID()}`;
    const first = await locks.acquire(name, 5_000);
    expect(first).not.toBeNull();
    expect(await locks.acquire(name, 5_000)).toBeNull();
    expect(await locks.release({ name, token: 'not-the-token' })).toBe(false);
    expect(await locks.extend(first!, 10_000)).toBe(true);
    expect(await locks.release(first!)).toBe(true);
    expect(await locks.acquire(name, 5_000)).not.toBeNull();
  });

  it('withLock waits for the lock and throws LockNotAcquiredError after the wait time', async () => {
    const locks = h.get(DistributedLockService);
    const name = `conversation:${randomUUID()}`;
    const order: string[] = [];
    await Promise.all([
      locks.withLock(name, { ttlMs: 5_000 }, async () => {
        order.push('a-start');
        await sleep(100);
        order.push('a-end');
      }),
      sleep(20).then(() =>
        locks.withLock(name, { ttlMs: 5_000, waitMs: 2_000 }, async () => {
          order.push('b');
        }),
      ),
    ]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);

    const held = await locks.acquire(name, 5_000);
    await expect(
      locks.withLock(name, { ttlMs: 1_000, waitMs: 100 }, async () => 'never'),
    ).rejects.toBeInstanceOf(LockNotAcquiredError);
    await locks.release(held!);
  });
});

const processed: string[] = [];
const retryAttempts: number[] = [];

@Injectable()
class MaintenanceProbeWorker implements OnApplicationBootstrap {
  constructor(private readonly workers: WorkerFactory) {}

  onApplicationBootstrap(): void {
    this.workers.create('maintenance', async (job) => {
      if (job.data.task === 'purge-messages') {
        throw new UnrecoverableError('probe failure');
      }
      if (job.data.task === 'purge-connect-tokens') {
        retryAttempts.push(job.attemptsMade);
        throw new Error('retry probe failure');
      }
      await sleep(300);
      processed.push(job.data.task);
    });
  }
}

@Module({ providers: [MaintenanceProbeWorker] })
class MaintenanceProbeModule {}

describe('WorkerFactory', () => {
  it('alerts on a job that failed its last attempt and finishes the current job on close', async () => {
    const worker = await h.startWorker([MaintenanceProbeModule], CoreWorkerRoot);
    const queues = h.get(QueuesService);
    await queues.add('maintenance', 'probe', { task: 'purge-messages' });
    const deadline = Date.now() + 10_000;
    while (
      !h.alerts.some((alert) => alert.title === 'Job failed in queue maintenance') &&
      Date.now() < deadline
    ) {
      await sleep(50);
    }
    expect(
      h.alerts.find((alert) => alert.title === 'Job failed in queue maintenance'),
    ).toMatchObject({
      details: { queue: 'maintenance', job_name: 'probe' },
    });

    // A retried job alerts only after its last attempt.
    await queues.add(
      'maintenance',
      'retry-probe',
      { task: 'purge-connect-tokens' },
      { attempts: 2, backoff: { type: 'fixed', delay: 10 } },
    );
    while (retryAttempts.length < 2 && Date.now() < deadline) {
      await sleep(20);
    }
    while (
      !h.alerts.some((alert) => alert.details?.['job_name'] === 'retry-probe') &&
      Date.now() < deadline
    ) {
      await sleep(20);
    }
    expect(retryAttempts).toEqual([0, 1]);
    expect(h.alerts.filter((alert) => alert.details?.['job_name'] === 'retry-probe')).toHaveLength(
      1,
    );

    await queues.add('maintenance', 'slow', { task: 'purge-raw-events' });
    const queue = queues.get('maintenance');
    while ((await queue.getActiveCount()) === 0 && Date.now() < deadline) {
      await sleep(20);
    }
    // Graceful shutdown: close() waits for the current job.
    await worker.close();
    expect(processed).toEqual(['purge-raw-events']);
  });
});
