import { randomUUID } from 'node:crypto';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Instance, Tenant } from '../../src/generated/prisma/client';
import { PURGE_BATCH_SIZE } from '../../src/maintenance/batch-purger';
import { MaintenanceTaskRegistry } from '../../src/maintenance/maintenance-task.registry';
import { MaintenanceWorkerModule } from '../../src/maintenance/maintenance.module';
import { MEDIA_OBJECT_STORE } from '../../src/maintenance/media-purge.task';
import type { MediaObjectStore } from '../../src/maintenance/media-purge.task';
import type { MaintenanceTaskName } from '../../src/queues/queue-names';
import { QueuesService } from '../../src/queues/queues.service';
import { TestHarness } from '../support/harness';
import { insertDelivery, messageStatusData } from '../support/webhooks';

const DAY = 86_400_000;

/** A fake object storage: it records the deleted keys and refuses the keys in `refuse`. */
class FakeMediaStore implements MediaObjectStore {
  readonly deleted: string[] = [];
  readonly refuse = new Set<string>();

  async deleteObjects(keys: readonly string[]): Promise<{ failedKeys: string[] }> {
    const failedKeys = keys.filter((key) => this.refuse.has(key));
    this.deleted.push(...keys.filter((key) => !this.refuse.has(key)));
    return { failedKeys };
  }
}

const store = new FakeMediaStore();
let h: TestHarness;
let worker: TestingModule;
let shortTenant: Tenant;
let defaultTenant: Tenant;
let shortInstance: Instance;
let defaultInstance: Instance;

beforeAll(async () => {
  h = await TestHarness.start({
    override: (builder) => builder.overrideProvider(MEDIA_OBJECT_STORE).useValue(store),
  });
  // A scheduler of a task that no longer exists: the worker removes it at start.
  await h
    .get(QueuesService)
    .get('maintenance')
    .upsertJobScheduler(
      'dispatch-outbox',
      { every: 3_600_000 },
      { data: { task: 'dispatch-outbox' } },
    );
  worker = await h.startWorker([MaintenanceWorkerModule]);
  shortTenant = await h.createTenant({ retentionDays: 7 });
  defaultTenant = await h.createTenant();
  shortInstance = await h.createInstance(shortTenant.id);
  defaultInstance = await h.createInstance(defaultTenant.id);
});

afterAll(async () => {
  await h?.close();
});

function task(name: MaintenanceTaskName) {
  const found = worker.get(MaintenanceTaskRegistry).get(name);
  if (!found) {
    throw new Error(`task ${name} is not registered`);
  }
  return found;
}

const ago = (ms: number) => new Date(Date.now() - ms);

describe('maintenance schedulers', () => {
  it('upserts one job scheduler for each task and removes the stale ones', async () => {
    const schedulers = await h.get(QueuesService).get('maintenance').getJobSchedulers();
    expect(schedulers.map((scheduler) => scheduler.key).sort()).toEqual(
      [
        'purge-connect-tokens',
        'purge-idempotency-keys',
        'purge-media-objects',
        'purge-messages',
        'purge-outbox-events',
        'purge-raw-events',
        'purge-webhook-deliveries',
      ].sort(),
    );
    // The tests below run the tasks directly: a scheduled run must not race with them.
    await h.get(QueuesService).get('maintenance').pause();
  });
});

describe('purge tasks', () => {
  it('deletes raw events older than 7 days in batches, also with two runs at the same time', async () => {
    const old = Array.from({ length: PURGE_BATCH_SIZE * 2 + 500 }, () => ({
      id: randomUUID(),
      eventType: 'ignored',
      payload: {},
      receivedAt: ago(8 * DAY),
    }));
    await h.prisma.rawEvent.createMany({ data: old });
    const recent = await h.prisma.rawEvent.create({
      data: { eventType: 'ignored', payload: {}, receivedAt: ago(6 * DAY) },
    });
    const runs = await Promise.all([
      task('purge-raw-events').run(new Date()),
      task('purge-raw-events').run(new Date()),
    ]);
    expect((runs[0]?.['deleted'] ?? 0) + (runs[1]?.['deleted'] ?? 0)).toBe(old.length);
    expect(await h.prisma.rawEvent.count()).toBe(1);
    expect(await h.prisma.rawEvent.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });

  it('deletes expired idempotency keys and connect tokens only', async () => {
    const tenantId = defaultTenant.id;
    const expired = await h.prisma.idempotencyKey.create({
      data: {
        tenantId,
        key: `k-${randomUUID()}`,
        requestHash: 'h',
        expiresAt: ago(1_000),
      },
    });
    const valid = await h.prisma.idempotencyKey.create({
      data: {
        tenantId,
        key: `k-${randomUUID()}`,
        requestHash: 'h',
        expiresAt: ago(-DAY),
      },
    });
    const token = (expiresAt: Date) =>
      h.prisma.connectToken.create({
        data: {
          tenantId,
          instanceId: defaultInstance.id,
          tokenHash: randomUUID(),
          method: 'qrcode',
          expiresAt,
        },
      });
    const oldToken = await token(ago(60_000));
    const liveToken = await token(ago(-600_000));

    await task('purge-idempotency-keys').run(new Date());
    await task('purge-connect-tokens').run(new Date());
    expect(await h.prisma.idempotencyKey.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await h.prisma.idempotencyKey.findUnique({ where: { id: valid.id } })).not.toBeNull();
    expect(await h.prisma.connectToken.findUnique({ where: { id: oldToken.id } })).toBeNull();
    expect(await h.prisma.connectToken.findUnique({ where: { id: liveToken.id } })).not.toBeNull();
  });

  it('deletes dispatched outbox events after 1 day and keeps the events that wait', async () => {
    const tenantId = defaultTenant.id;
    const row = (dispatchedAt: Date | null) =>
      h.prisma.outboxEvent.create({
        data: {
          tenantId,
          type: 'message.status',
          payload: messageStatusData(),
          dispatchedAt,
        },
      });
    const old = await row(ago(2 * DAY));
    const fresh = await row(ago(60_000));
    const waiting = await row(null);
    await task('purge-outbox-events').run(new Date());
    const left = await h.prisma.outboxEvent.findMany({
      where: { id: { in: [old.id, fresh.id, waiting.id] } },
    });
    expect(left.map((event) => event.id).sort()).toEqual([fresh.id, waiting.id].sort());
    await h.prisma.outboxEvent.delete({ where: { id: waiting.id } });
  });

  it('deletes the messages older than the retention of each tenant (rows, not only the content)', async () => {
    const message = (tenant: Tenant, instance: Instance, createdAt: Date) =>
      h.prisma.message.create({
        data: {
          tenantId: tenant.id,
          instanceId: instance.id,
          direction: 'outbound',
          type: 'text',
          status: 'sent',
          contact: '5511987654321',
          content: { type: 'text', text: 'Oi' },
          createdAt,
        },
      });
    const shortOld = await message(shortTenant, shortInstance, ago(10 * DAY));
    const shortNew = await message(shortTenant, shortInstance, ago(3 * DAY));
    const defaultTen = await message(defaultTenant, defaultInstance, ago(10 * DAY));
    const defaultOld = await message(defaultTenant, defaultInstance, ago(91 * DAY));

    const result = await task('purge-messages').run(new Date());
    expect(result['deleted']).toBe(2);
    const left = await h.prisma.message.findMany({
      where: {
        id: { in: [shortOld.id, shortNew.id, defaultTen.id, defaultOld.id] },
      },
    });
    expect(left.map((row) => row.id).sort()).toEqual([shortNew.id, defaultTen.id].sort());
  });

  it('deletes webhook deliveries after 30 days, or after the shorter retention of the tenant', async () => {
    const subscription = (tenantId: string) =>
      h.prisma.webhookSubscription.create({
        data: {
          tenantId,
          url: 'https://hooks.example.com/',
          events: ['message.status'],
          secretEncrypted: 'x',
        },
      });
    const shortSub = await subscription(shortTenant.id);
    const defaultSub = await subscription(defaultTenant.id);
    const make = (tenantId: string, subscriptionId: string, age: number) =>
      insertDelivery(h.prisma, {
        tenantId,
        subscriptionId,
        status: 'succeeded',
        createdAt: ago(age),
      });
    const shortOld = await make(shortTenant.id, shortSub.id, 10 * DAY);
    const defaultTen = await make(defaultTenant.id, defaultSub.id, 10 * DAY);
    const defaultOld = await make(defaultTenant.id, defaultSub.id, 31 * DAY);

    await task('purge-webhook-deliveries').run(new Date());
    const left = await h.prisma.webhookDelivery.findMany({
      where: { id: { in: [shortOld.id, defaultTen.id, defaultOld.id] } },
    });
    expect(left.map((row) => row.id)).toEqual([defaultTen.id]);
  });

  it('deletes old media in the object storage first, keeps a row when its key fails, and alerts', async () => {
    const media = (tenantId: string, key: string, createdAt: Date) =>
      h.prisma.mediaObject.create({
        data: {
          tenantId,
          key,
          contentType: 'image/jpeg',
          sizeBytes: 10,
          direction: 'inbound',
          createdAt,
        },
      });
    const oldKey = `${shortTenant.id}/${randomUUID()}.jpg`;
    const refusedKey = `${shortTenant.id}/${randomUUID()}.jpg`;
    const freshKey = `${shortTenant.id}/${randomUUID()}.jpg`;
    await media(shortTenant.id, oldKey, ago(8 * DAY));
    const refused = await media(shortTenant.id, refusedKey, ago(9 * DAY));
    await media(shortTenant.id, freshKey, ago(DAY));
    store.refuse.add(refusedKey);

    const result = await task('purge-media-objects').run(new Date());
    expect(result).toEqual({ deleted: 1, failed: 1 });
    expect(store.deleted).toContain(oldKey);
    expect(store.deleted).not.toContain(freshKey);
    const keys = (
      await h.prisma.mediaObject.findMany({
        where: { tenantId: shortTenant.id },
      })
    ).map((row) => row.key);
    expect(keys.sort()).toEqual([refusedKey, freshKey].sort());
    expect(h.alerts.map((alert) => alert.title)).toContain(
      'Media objects not deleted from the object storage',
    );

    store.refuse.clear();
    await task('purge-media-objects').run(new Date());
    expect(await h.prisma.mediaObject.findUnique({ where: { id: refused.id } })).toBeNull();
  });
});
