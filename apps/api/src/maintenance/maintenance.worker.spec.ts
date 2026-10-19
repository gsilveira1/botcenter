import { describe, expect, it, vi } from 'vitest';
import type { MetricsService } from '../metrics/metrics.service';
import type { QueuesService } from '../queues/queues.service';
import { UnrecoverableError } from '../queues/worker.factory';
import type { WorkerFactory } from '../queues/worker.factory';
import { MaintenanceTaskRegistry } from './maintenance-task.registry';
import { MaintenanceWorker } from './maintenance.worker';

describe('MaintenanceTaskRegistry and MaintenanceWorker', () => {
  function workerWith(registry: MaintenanceTaskRegistry) {
    const counter = { inc: vi.fn() };
    const metrics = { counter: () => counter } as unknown as MetricsService;
    return new MaintenanceWorker({} as WorkerFactory, {} as QueuesService, registry, metrics);
  }

  it('refuses a second task with the same name', () => {
    const registry = new MaintenanceTaskRegistry();
    const task = { name: 'purge-raw-events' as const, everyMs: 1, run: async () => ({}) };
    registry.register(task);
    expect(() => registry.register(task)).toThrow(/already registered/);
  });

  it('runs the task of the job and fails at once for an unknown task', async () => {
    const registry = new MaintenanceTaskRegistry();
    const run = vi.fn(async () => ({ deleted: 3 }));
    registry.register({ name: 'purge-raw-events', everyMs: 1, run });
    const worker = workerWith(registry);
    await expect(worker.process({ task: 'purge-raw-events' })).resolves.toEqual({ deleted: 3 });
    await expect(worker.process({ task: 'check-alerts' })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('lets a task error go to the queue (retry, then the WorkerFactory alert)', async () => {
    const registry = new MaintenanceTaskRegistry();
    registry.register({
      name: 'purge-messages',
      everyMs: 1,
      run: async () => {
        throw new Error('database down');
      },
    });
    await expect(workerWith(registry).process({ task: 'purge-messages' })).rejects.toThrow(
      'database down',
    );
  });
});
