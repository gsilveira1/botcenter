import { randomUUID } from 'node:crypto';
import type { TestingModule } from '@nestjs/testing';
import { verifyWebhook } from '@botcenter/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationalAlertsTask } from '../../src/maintenance/operational-alerts.task';
import { MetricsService } from '../../src/metrics/metrics.service';
import { QueuesService } from '../../src/queues/queues.service';
import { OutboxService } from '../../src/services/outbox.service';
import { SecretBox } from '../../src/services/secret-box';
import { OUTBOX_BATCH_SIZE, OutboxDispatcher } from '../../src/webhooks/outbox-dispatcher';
import {
  WEBHOOK_DELIVERY_SETTINGS,
  generateWebhookSecret,
} from '../../src/webhooks/webhook-delivery.policy';
import type { WebhookDeliverySettings } from '../../src/webhooks/webhook-delivery.policy';
import { deliveryJobId } from '../../src/webhooks/webhook-delivery.jobs';
import { WebhookDeliveryWorker } from '../../src/webhooks/webhook-delivery.worker';
import { WebhookSweepTask } from '../../src/webhooks/webhook-sweep.task';
import { WebhooksApiModule, WebhooksWorkerModule } from '../../src/webhooks/webhooks.module';
import { TestHarness } from '../support/harness';
import { TestReceiver, hang, respond } from '../support/receiver';
import type { ReceivedRequest } from '../support/receiver';
import { waitFor } from '../support/wait-for';
import { insertDelivery, messageStatusData } from '../support/webhooks';

/**
 * Decision (wave 0 note): the contracts accept only HTTPS URLs in requests, so these tests write the
 * subscription rows directly with an HTTP URL of a local receiver, and the environment allows HTTP and
 * private addresses (`NODE_ENV=test`, `EXTERNAL_HTTP_ALLOW_PRIVATE=true`). The HTTPS path of the client
 * has its own unit tests with a self-signed certificate (`external-http.client.spec.ts`).
 */
const SETTINGS: WebhookDeliverySettings = { requestTimeoutMs: 400, retryDelaysSeconds: [0.2, 0.2] };

let h: TestHarness;
let worker: TestingModule;
let receiver: TestReceiver;

beforeAll(async () => {
  receiver = await TestReceiver.start();
  h = await TestHarness.start({
    modules: [WebhooksApiModule],
    env: { EXTERNAL_HTTP_ALLOW_PRIVATE: 'true', OUTBOX_DISPATCH_INTERVAL_MS: '100' },
    override: (builder) => builder.overrideProvider(WEBHOOK_DELIVERY_SETTINGS).useValue(SETTINGS),
  });
  worker = await h.startWorker([WebhooksWorkerModule]);
});

afterAll(async () => {
  await h?.close();
  await receiver?.close();
});

async function subscribe(tenantId: string, events = ['message.status']) {
  const path = `/hook/${randomUUID()}`;
  const row = await h.prisma.webhookSubscription.create({
    data: { tenantId, url: `${receiver.url}${path}`, events, secretEncrypted: 'pending' },
  });
  const secret = generateWebhookSecret();
  await h.prisma.webhookSubscription.update({
    where: { id: row.id },
    data: { secretEncrypted: h.get(SecretBox).encrypt(secret, row.id) },
  });
  return { id: row.id, path, secret };
}

async function emit(tenantId: string, type: 'message.status' = 'message.status'): Promise<string> {
  const outbox = h.get(OutboxService);
  return h.prisma.$transaction((tx) =>
    outbox.enqueue(tx, { tenantId, type, payload: messageStatusData() }),
  );
}

function requestsTo(path: string): ReceivedRequest[] {
  return receiver.requests.filter((request) => request.url === path);
}

async function deliveryOf(eventId: string, subscriptionId: string) {
  return h.prisma.webhookDelivery.findUnique({
    where: { subscriptionId_eventId: { subscriptionId, eventId } },
  });
}

async function waitForStatus(eventId: string, subscriptionId: string, status: string) {
  await waitFor(async () => (await deliveryOf(eventId, subscriptionId))?.status === status);
  return (await deliveryOf(eventId, subscriptionId))!;
}

async function deliveredCount(result: string): Promise<number> {
  const metric = await worker.get(MetricsService).webhookDeliveriesTotal.get();
  return metric.values.find((value) => value.labels.result === result)?.value ?? 0;
}

describe('outbox dispatcher and delivery worker', () => {
  it('delivers a signed envelope that the contracts verifyWebhook accepts', async () => {
    const tenant = await h.createTenant();
    const sub = await subscribe(tenant.id);
    const before = await deliveredCount('succeeded');
    const eventId = await emit(tenant.id);

    const delivery = await waitForStatus(eventId, sub.id, 'succeeded');
    expect(delivery).toMatchObject({ attempts: 1, lastStatusCode: 204, nextAttemptAt: null });
    const [request] = requestsTo(sub.path);
    expect(request?.headers['webhook-id']).toBe(eventId);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(
      verifyWebhook({
        secret: sub.secret,
        signature: request?.headers['webhook-signature'] as string,
        timestamp: request?.headers['webhook-timestamp'] as string,
        rawBody: request?.body ?? '',
      }),
    ).toEqual({ valid: true });
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({
      id: eventId,
      type: 'message.status',
      created_at: expect.any(String),
      data: { status: 'delivered' },
    });
    const event = await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.dispatchedAt).toBeInstanceOf(Date);
    expect(await deliveredCount('succeeded')).toBe(before + 1);
  });

  it('fans out to each matching subscription of the tenant only', async () => {
    const tenant = await h.createTenant();
    const other = await h.createTenant();
    const statusSub = await subscribe(tenant.id, ['message.status', 'instance.status']);
    const receivedSub = await subscribe(tenant.id, ['message.received']);
    const otherSub = await subscribe(other.id, ['message.status']);
    const eventId = await emit(tenant.id);

    await waitForStatus(eventId, statusSub.id, 'succeeded');
    await waitFor(
      async () =>
        (await h.prisma.outboxEvent.findUnique({ where: { id: eventId } }))?.dispatchedAt !== null,
    );
    expect(await h.prisma.webhookDelivery.count({ where: { eventId } })).toBe(1);
    expect(requestsTo(receivedSub.path)).toHaveLength(0);
    expect(requestsTo(otherSub.path)).toHaveLength(0);
  });

  it('retries a 500 with the same event id and succeeds on the next attempt', async () => {
    const tenant = await h.createTenant();
    const sub = await subscribe(tenant.id);
    receiver.next(respond(500, 'error'));
    const eventId = await emit(tenant.id);

    await waitFor(async () => requestsTo(sub.path).length >= 1);
    const delivery = await waitForStatus(eventId, sub.id, 'succeeded');
    expect(delivery.attempts).toBe(2);
    const requests = requestsTo(sub.path);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.headers['webhook-id'])).toEqual([eventId, eventId]);
  });

  it('marks a delivery dead after the last attempt (time limit), alerts once, and redelivers it', async () => {
    const tenant = await h.createTenant();
    const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['events:read'] });
    const sub = await subscribe(tenant.id);
    receiver.next(hang(), hang(), hang());
    const eventId = await emit(tenant.id);

    const dead = await waitForStatus(eventId, sub.id, 'dead');
    expect(dead).toMatchObject({ attempts: 3, lastError: 'timeout', lastStatusCode: null });
    expect(dead.nextAttemptAt).toBeNull();

    const alerts = worker.get(OperationalAlertsTask);
    const now = new Date();
    await alerts.checkWebhookFailures(now);
    await alerts.checkWebhookFailures(now);
    const raised = h.alerts.filter((alert) => alert.details?.['tenant_id'] === tenant.id);
    expect(raised.map((alert) => alert.title)).toEqual([
      'Webhook deliveries of a tenant are failing',
    ]);

    const response = await h.inject({
      method: 'POST',
      url: `/v1/webhooks/deliveries/${dead.id}/redeliver`,
      headers: h.bearer(key),
    });
    expect(response.statusCode).toBe(202);
    const delivered = await waitForStatus(eventId, sub.id, 'succeeded');
    expect(delivered.attempts).toBe(1);

    await alerts.checkWebhookFailures(new Date());
    expect(
      h.alerts.filter((alert) => alert.details?.['tenant_id'] === tenant.id).map((a) => a.title),
    ).toEqual([
      'Webhook deliveries of a tenant are failing',
      'Resolved: webhook deliveries of a tenant succeed',
    ]);
  });

  it('signs with the old and the new secret during a rotation', async () => {
    const tenant = await h.createTenant();
    const sub = await subscribe(tenant.id);
    const newSecret = generateWebhookSecret();
    const box = h.get(SecretBox);
    const current = await h.prisma.webhookSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    await h.prisma.webhookSubscription.update({
      where: { id: sub.id },
      data: {
        secretEncrypted: box.encrypt(newSecret, sub.id),
        previousSecretEncrypted: current.secretEncrypted,
        previousSecretExpiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const eventId = await emit(tenant.id);
    await waitForStatus(eventId, sub.id, 'succeeded');
    const [request] = requestsTo(sub.path);
    for (const secret of [newSecret, sub.secret]) {
      expect(
        verifyWebhook({
          secret,
          signature: request?.headers['webhook-signature'] as string,
          timestamp: request?.headers['webhook-timestamp'] as string,
          rawBody: request?.body ?? '',
        }).valid,
      ).toBe(true);
    }
  });

  it('stops a delivery of a deleted webhook without a request', async () => {
    const tenant = await h.createTenant();
    const sub = await subscribe(tenant.id);
    await h.prisma.webhookSubscription.update({
      where: { id: sub.id },
      data: { deletedAt: new Date(), active: false },
    });
    const delivery = await insertDelivery(h.prisma, {
      tenantId: tenant.id,
      subscriptionId: sub.id,
    });
    const outcome = await worker
      .get(WebhookDeliveryWorker)
      .deliver({ tenantId: tenant.id, deliveryId: delivery.id });
    expect(outcome).toBe('stopped');
    expect(requestsTo(sub.path)).toHaveLength(0);
    const row = await h.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row).toMatchObject({ status: 'dead', lastError: 'webhook_deleted' });
  });

  it('lets only one of two concurrent jobs of the same delivery send (lease)', async () => {
    const tenant = await h.createTenant();
    const sub = await subscribe(tenant.id);
    const delivery = await insertDelivery(h.prisma, {
      tenantId: tenant.id,
      subscriptionId: sub.id,
    });
    const deliveries = worker.get(WebhookDeliveryWorker);
    const data = { tenantId: tenant.id, deliveryId: delivery.id };
    const outcomes = await Promise.all([deliveries.deliver(data), deliveries.deliver(data)]);
    expect(outcomes.sort()).toEqual(['skipped', 'succeeded']);
    expect(requestsTo(sub.path)).toHaveLength(1);
    // A job of another tenant never reads the row.
    const other = await h.createTenant();
    const foreign = await deliveries.deliver({ tenantId: other.id, deliveryId: delivery.id });
    expect(foreign).toBe('skipped');
  });

  it('refuses a redelivery while a worker holds the lease of a failed delivery (one send only)', async () => {
    const tenant = await h.createTenant();
    const sub = await subscribe(tenant.id);
    const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['events:read'] });
    const delivery = await insertDelivery(h.prisma, {
      tenantId: tenant.id,
      subscriptionId: sub.id,
      status: 'failed',
      attempts: 1,
    });
    receiver.next((_request, response) => {
      setTimeout(() => response.writeHead(204).end(), 300);
    });
    const attempt = worker
      .get(WebhookDeliveryWorker)
      .deliver({ tenantId: tenant.id, deliveryId: delivery.id });
    await waitFor(async () => requestsTo(sub.path).length === 1);

    const redeliver = await h.inject({
      method: 'POST',
      url: `/v1/webhooks/deliveries/${delivery.id}/redeliver`,
      headers: h.bearer(key),
    });
    expect(redeliver.statusCode).toBe(409);
    expect(await attempt).toBe('succeeded');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(requestsTo(sub.path)).toHaveLength(1);
  });

  it('sweeps an overdue delivery without a job and delivers it', async () => {
    const tenant = await h.createTenant();
    const sub = await subscribe(tenant.id);
    const delivery = await insertDelivery(h.prisma, {
      tenantId: tenant.id,
      subscriptionId: sub.id,
      nextAttemptAt: new Date(Date.now() - 120_000),
    });
    const queue = h.get(QueuesService).get('webhooks');
    expect(await queue.getJob(deliveryJobId(delivery))).toBeUndefined();

    const result = await worker.get(WebhookSweepTask).run(new Date());
    expect(result['requeued']).toBeGreaterThanOrEqual(1);
    await waitFor(
      async () =>
        (await h.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
          .status === 'succeeded',
    );
    // A second sweep finds nothing to add for this delivery.
    const again = await worker.get(WebhookSweepTask).run(new Date());
    expect(again['requeued']).toBe(0);
  });
});

describe('outbox dispatcher concurrency and order', () => {
  async function emitMany(tenantId: string, count: number): Promise<void> {
    const outbox = h.get(OutboxService);
    await h.prisma.$transaction(async (tx) => {
      for (let index = 0; index < count; index += 1) {
        await outbox.enqueue(tx, {
          tenantId,
          type: 'message.status',
          payload: messageStatusData(),
        });
      }
    });
  }

  it('never fans out an event two times when several dispatchers run at once', async () => {
    const tenant = await h.createTenant();
    const sub = await subscribe(tenant.id, ['message.status']);
    await emitMany(tenant.id, OUTBOX_BATCH_SIZE + 50);
    const dispatcher = worker.get(OutboxDispatcher);
    // The loop of the worker runs too: four dispatchers in total.
    const counts = await Promise.all([
      dispatcher.dispatchBatch(),
      dispatcher.dispatchBatch(),
      dispatcher.dispatchBatch(),
    ]);
    await waitFor(
      async () =>
        (await h.prisma.outboxEvent.count({
          where: { tenantId: tenant.id, dispatchedAt: null },
        })) === 0,
    );
    expect(counts.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(
      OUTBOX_BATCH_SIZE + 50,
    );
    expect(await h.prisma.webhookDelivery.count({ where: { subscriptionId: sub.id } })).toBe(
      OUTBOX_BATCH_SIZE + 50,
    );
    await waitFor(async () => requestsTo(sub.path).length === OUTBOX_BATCH_SIZE + 50, 30_000);
    const ids = requestsTo(sub.path).map((request) => request.headers['webhook-id']);
    expect(new Set(ids).size).toBe(OUTBOX_BATCH_SIZE + 50);
  });

  it('dispatches the events in creation order', async () => {
    const tenant = await h.createTenant();
    await emitMany(tenant.id, 2 * OUTBOX_BATCH_SIZE + 10);
    await waitFor(
      async () =>
        (await h.prisma.outboxEvent.count({
          where: { tenantId: tenant.id, dispatchedAt: null },
        })) === 0,
    );
    const events = await h.prisma.outboxEvent.findMany({
      where: { tenantId: tenant.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { dispatchedAt: true },
    });
    const times = events.map((event) => event.dispatchedAt?.getTime() ?? 0);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
