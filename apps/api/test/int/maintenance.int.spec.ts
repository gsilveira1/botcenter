import { randomUUID } from 'node:crypto';
import type { TestingModule } from '@nestjs/testing';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Instance, Tenant } from '../../src/generated/prisma/client';
import { PURGE_BATCH_SIZE } from '../../src/maintenance/batch-purger';
import { MaintenanceTaskRegistry } from '../../src/maintenance/maintenance-task.registry';
import { MaintenanceWorkerModule } from '../../src/maintenance/maintenance.module';
import { MediaStorage, S3_CLIENT } from '../../src/media/media.storage';
import { OperationalAlertsTask } from '../../src/maintenance/operational-alerts.task';
import type { MaintenanceTaskName } from '../../src/queues/queue-names';
import { QueuesService } from '../../src/queues/queues.service';
import { WebhooksApiModule } from '../../src/webhooks/webhooks.module';
import { CoreWorkerRoot } from '../support/core-worker-root';
import { TestHarness } from '../support/harness';
import { insertDelivery, messageStatusData } from '../support/webhooks';

const DAY = 86_400_000;

let h: TestHarness;
let worker: TestingModule;
let shortTenant: Tenant;
let defaultTenant: Tenant;
let shortInstance: Instance;
let defaultInstance: Instance;

beforeAll(async () => {
  h = await TestHarness.start({
    modules: [WebhooksApiModule],
    minio: true,
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
  worker = await h.startWorker([MaintenanceWorkerModule], CoreWorkerRoot);
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
        'check-alerts',
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
      data: { tenantId, key: `k-${randomUUID()}`, requestHash: 'h', expiresAt: ago(1_000) },
    });
    const valid = await h.prisma.idempotencyKey.create({
      data: { tenantId, key: `k-${randomUUID()}`, requestHash: 'h', expiresAt: ago(-DAY) },
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
        data: { tenantId, type: 'message.status', payload: messageStatusData(), dispatchedAt },
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
      where: { id: { in: [shortOld.id, shortNew.id, defaultTen.id, defaultOld.id] } },
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
    const storage = worker.get(MediaStorage, { strict: false });
    const s3 = worker.get<S3Client>(S3_CLIENT, { strict: false });
    const media = async (key: string, createdAt: Date, expiresAt: Date | null = null) => {
      await s3.send(
        new PutObjectCommand({
          Bucket: h.minio.bucket,
          Key: key,
          Body: 'jpeg',
          ContentType: 'image/jpeg',
        }),
      );
      return h.prisma.mediaObject.create({
        data: {
          tenantId: shortTenant.id,
          key,
          contentType: 'image/jpeg',
          sizeBytes: 4,
          direction: 'inbound',
          createdAt,
          expiresAt,
        },
      });
    };
    const key = () => `tenants/${shortTenant.id}/inbound/${randomUUID()}`;
    const old = await media(key(), ago(8 * DAY));
    const expired = await media(key(), ago(DAY), ago(1_000));
    const refused = await media(key(), ago(9 * DAY));
    const fresh = await media(key(), ago(DAY), ago(-6 * DAY));

    const realDelete = storage.deleteObjects.bind(storage);
    const spy = vi.spyOn(storage, 'deleteObjects').mockImplementationOnce(async (keys) => {
      await realDelete(keys.filter((candidate) => candidate !== refused.key));
      return { failedKeys: [refused.key] };
    });
    const result = await task('purge-media-objects').run(new Date());
    expect(result).toEqual({ deleted: 2, failed: 1 });
    expect(await storage.head(old.key)).toBeNull();
    expect(await storage.head(expired.key)).toBeNull();
    expect(await storage.head(fresh.key)).not.toBeNull();
    const keys = (await h.prisma.mediaObject.findMany({ where: { tenantId: shortTenant.id } })).map(
      (row) => row.key,
    );
    expect(keys.sort()).toEqual([refused.key, fresh.key].sort());
    expect(h.alerts.map((alert) => alert.title)).toContain(
      'Media objects not deleted from the object storage',
    );

    spy.mockRestore();
    await task('purge-media-objects').run(new Date());
    expect(await h.prisma.mediaObject.findUnique({ where: { id: refused.id } })).toBeNull();
    expect(await storage.head(refused.key)).toBeNull();
  });
});

describe('operational alerts (check-alerts)', () => {
  function titles(): string[] {
    return h.alerts.map((alert) => alert.title);
  }

  it('alerts once when a send waits more than 30 s, ignores the sweep job, and sends a recovery message', async () => {
    const alerts = worker.get(OperationalAlertsTask);
    // The worker process of the test also consumes `outbound`: a paused queue keeps the jobs waiting.
    const queue = h.get(QueuesService).get('outbound');
    await queue.pause();
    try {
      const sweep = await queue.add('sweep', {} as never);
      const later = new Date(Date.now() + 31_000);
      expect(await alerts.checkOutboundDelay(later)).toBe('unchanged');
      const send = await queue.add(
        'send',
        { tenantId: defaultTenant.id, messageId: randomUUID(), instanceId: defaultInstance.id },
        { priority: 10 },
      );
      expect(await alerts.checkOutboundDelay(later)).toBe('opened');
      expect(await alerts.checkOutboundDelay(later)).toBe('unchanged');
      await send.remove();
      expect(await alerts.checkOutboundDelay(later)).toBe('resolved');
      await sweep.remove();
    } finally {
      await queue.resume();
    }
    expect(
      titles().filter(
        (title) => title.includes('Outbound queue') || title.includes('outbound queue'),
      ),
    ).toEqual(['Outbound queue delay above 30 s', 'Resolved: outbound queue delay is normal']);
  });

  it('alerts when more than 5 % of the sends of the last 10 min failed', async () => {
    const alerts = worker.get(OperationalAlertsTask);
    const rows = Array.from({ length: 20 }, (_, index) => ({
      tenantId: defaultTenant.id,
      instanceId: defaultInstance.id,
      direction: 'outbound' as const,
      type: 'text' as const,
      status: index < 2 ? ('failed' as const) : ('delivered' as const),
      contact: '5511987654321',
      content: {},
    }));
    await h.prisma.message.createMany({ data: rows });
    expect(await alerts.checkSendFailureRate(new Date())).toBe('opened');
    await h.prisma.message.deleteMany({ where: { tenantId: defaultTenant.id, status: 'failed' } });
    expect(await alerts.checkSendFailureRate(new Date())).toBe('resolved');
  });

  it('alerts when the outbox is late and exposes the lag gauge in the API process', async () => {
    const alerts = worker.get(OperationalAlertsTask);
    const event = await h.prisma.outboxEvent.create({
      data: {
        tenantId: defaultTenant.id,
        type: 'message.status',
        payload: messageStatusData(),
        createdAt: ago(120_000),
      },
    });
    expect(await alerts.checkOutboxLag(new Date())).toBe('opened');
    const metrics = await h.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toMatch(/botcenter_outbox_lag_seconds\{role="api"\} 1[2-9]\d/);
    await h.prisma.outboxEvent.update({
      where: { id: event.id },
      data: { dispatchedAt: new Date() },
    });
    expect(await alerts.checkOutboxLag(new Date())).toBe('resolved');
  });

  it('runs all the checks as one task', async () => {
    await expect(task('check-alerts').run(new Date())).resolves.toEqual({
      opened: expect.any(Number),
      resolved: expect.any(Number),
    });
  });
});
