import { Module } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Instance } from '../../src/generated/prisma/client';
import { ConnectChannelService } from '../../src/instances/connect-channel.service';
import {
  ConnectionMonitorService,
  INCIDENT_ALERT_AFTER_MS,
  RECONCILE_AFTER_MS,
} from '../../src/instances/connection-monitor.service';
import { InstanceStatusService } from '../../src/instances/instance-status.service';
import { InstancesWorkerModule } from '../../src/instances/instances.module';
import { INSTANCES_SCHEDULES } from '../../src/instances/instances-jobs.worker';
import { QueuesService } from '../../src/queues/queues.service';
import { TestHarness } from '../support/harness';
import { waitFor } from '../support/wait-for';

/**
 * The connection monitor with a fake clock: the test passes `now` to each run. The services run in the
 * API app of the harness (no scheduler), so only the test starts a run. The last test starts the worker
 * and checks the job schedulers.
 */
@Module({ providers: [ConnectionMonitorService, InstanceStatusService, ConnectChannelService] })
class MonitorProbeModule {}

let h: TestHarness;
let monitor: ConnectionMonitorService;
let statuses: InstanceStatusService;

beforeAll(async () => {
  h = await TestHarness.start({ modules: [MonitorProbeModule] });
  monitor = h.get(ConnectionMonitorService);
  statuses = h.get(InstanceStatusService);
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  // Each test starts without open incidents of earlier tests.
  await h.prisma.instance.updateMany({
    data: { deletedAt: new Date(), disconnectAlertedAt: null, disconnectedSince: null },
  });
  h.alerts.length = 0;
});

const minutes = (base: Date, count: number) => new Date(base.getTime() + count * 60_000);

async function instanceIn(status: 'connected' | 'connecting' | 'created'): Promise<Instance> {
  const tenant = await h.createTenant();
  const instance = await h.createInstance(tenant.id, { providerCreatedAt: new Date() });
  await h.provider.createInstance({
    name: instance.providerName,
    webhookUrl: 'x',
    webhookSecret: 'y',
  });
  if (status !== 'created') {
    await statuses.transition({ providerName: instance.providerName }, { next: 'connecting' });
  }
  if (status === 'connected') {
    await statuses.transition({ providerName: instance.providerName }, { next: 'connected' });
  }
  return instance;
}

describe('ConnectionMonitorService.checkIncidents', () => {
  it('alerts one time after 2 minutes, and sends one recovery message after the reconnect', async () => {
    const instance = await instanceIn('connected');
    const lostAt = new Date();
    // The provider reports a lost connection as `connecting`.
    await statuses.transition(
      { providerName: instance.providerName },
      { next: 'connecting', now: lostAt },
    );

    expect(await monitor.checkIncidents(minutes(lostAt, 1))).toEqual({ alerted: 0, recovered: 0 });
    expect(h.alerts).toEqual([]);

    expect(await monitor.checkIncidents(minutes(lostAt, 2.5))).toEqual({
      alerted: 1,
      recovered: 0,
    });
    expect(h.alerts).toEqual([
      expect.objectContaining({
        severity: 'critical',
        title: '1 instance(s) disconnected for more than 2 minutes',
        details: { instances: `${instance.id} (connecting, tenant ${instance.tenantId})` },
      }),
    ]);

    // No repeat alert for the same incident, also when it moves to disconnected.
    await statuses.transition({ providerName: instance.providerName }, { next: 'disconnected' });
    expect(await monitor.checkIncidents(minutes(lostAt, 5))).toEqual({ alerted: 0, recovered: 0 });

    await statuses.transition({ providerName: instance.providerName }, { next: 'connected' });
    expect(await monitor.checkIncidents(minutes(lostAt, 6))).toEqual({ alerted: 0, recovered: 1 });
    expect(h.alerts.at(-1)).toMatchObject({
      severity: 'info',
      title: '1 instance(s) no longer disconnected',
    });
    expect(await monitor.checkIncidents(minutes(lostAt, 7))).toEqual({ alerted: 0, recovered: 0 });
    expect(h.alerts).toHaveLength(2);
  });

  it('does not alert for the first connect flow or a short incident', async () => {
    const flow = await instanceIn('connecting');
    const short = await instanceIn('connected');
    const now = new Date();
    await statuses.transition({ providerName: short.providerName }, { next: 'connecting', now });
    await statuses.transition({ providerName: short.providerName }, { next: 'connected' });

    expect(await monitor.checkIncidents(minutes(now, 30))).toEqual({ alerted: 0, recovered: 0 });
    expect(
      (await h.prisma.instance.findUniqueOrThrow({ where: { id: flow.id } })).disconnectAlertedAt,
    ).toBeNull();
  });

  it('lists many incidents in one alert and ends the incident of a deleted instance', async () => {
    const lostAt = new Date();
    const rows: Instance[] = [];
    for (let index = 0; index < 12; index += 1) {
      const instance = await instanceIn('connected');
      await statuses.transition(
        { providerName: instance.providerName },
        { next: 'disconnected', now: lostAt },
      );
      rows.push(instance);
    }

    const result = await monitor.checkIncidents(
      new Date(lostAt.getTime() + INCIDENT_ALERT_AFTER_MS),
    );

    expect(result.alerted).toBe(12);
    expect(h.alerts).toHaveLength(1);
    expect(String(h.alerts[0]!.details?.['instances'])).toContain('and 2 more');

    await h.prisma.instance.update({ where: { id: rows[0]!.id }, data: { deletedAt: new Date() } });
    expect(await monitor.checkIncidents(minutes(lostAt, 4))).toEqual({ alerted: 0, recovered: 1 });
  });
});

describe('ConnectionMonitorService.reconcile', () => {
  it('corrects a status from the provider state after a lost webhook', async () => {
    const instance = await instanceIn('connected');
    await statuses.transition({ providerName: instance.providerName }, { next: 'connecting' });
    h.provider.setState(instance.providerName, 'connected');
    const now = new Date();

    expect(await monitor.reconcile(minutes(now, 5))).toEqual({
      checked: 0,
      changed: 0,
      stopped: false,
    });
    const result = await monitor.reconcile(new Date(now.getTime() + RECONCILE_AFTER_MS + 1_000));

    expect(result).toEqual({ checked: 1, changed: 1, stopped: false });
    const row = await h.prisma.instance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(row.status).toBe('connected');
    expect(row.disconnectedSince).toBeNull();
    const events = await h.prisma.outboxEvent.findMany({
      where: { tenantId: instance.tenantId, type: 'instance.status' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.at(-1)!.payload).toMatchObject({
      status: 'connected',
      previous_status: 'connecting',
    });
  });

  it('marks an instance that the provider lost as logged_out, and stops when the provider is down', async () => {
    const lost = await instanceIn('connected');
    await statuses.transition({ providerName: lost.providerName }, { next: 'disconnected' });
    await h.provider.deleteInstance(lost.providerName);
    const later = new Date(Date.now() + RECONCILE_AFTER_MS + 1_000);

    expect(await monitor.reconcile(later)).toMatchObject({ checked: 1, changed: 1 });
    const row = await h.prisma.instance.findUniqueOrThrow({ where: { id: lost.id } });
    expect(row.status).toBe('logged_out');
    expect(row.providerCreatedAt).toBeNull();

    const down = await instanceIn('connected');
    await statuses.transition({ providerName: down.providerName }, { next: 'disconnected' });
    h.provider.failNext('getConnectionState', 'unavailable');
    expect(await monitor.reconcile(later)).toEqual({ checked: 0, changed: 0, stopped: true });
  });
});

describe('InstancesWorkerModule', () => {
  it('writes the job schedulers of the instances queue and runs the monitor', async () => {
    await h.startWorker([InstancesWorkerModule]);
    const queue = h.get(QueuesService).get('instances');

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((scheduler) => scheduler.key).sort()).toEqual(
      INSTANCES_SCHEDULES.map((schedule) => schedule.id).sort(),
    );
    await waitFor(async () => (await queue.getCompletedCount()) >= 1);
    expect(h.alerts.filter((alert) => alert.title.startsWith('Job failed'))).toEqual([]);
  });
});
