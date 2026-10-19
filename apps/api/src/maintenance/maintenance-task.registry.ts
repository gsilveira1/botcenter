import { Injectable } from '@nestjs/common';
import type { MaintenanceTaskName } from '../queues/queue-names';

/** The result of one run: counts only (rows deleted, alerts opened), for the log line. */
export type MaintenanceTaskResult = Record<string, number>;

/**
 * One scheduled task of the `maintenance` queue. `run` must be idempotent and safe when two runs overlap
 * (batch deletes with `FOR UPDATE SKIP LOCKED`, or a Redis guard).
 */
export interface MaintenanceTask {
  readonly name: MaintenanceTaskName;
  /** The interval of the BullMQ job scheduler. */
  readonly everyMs: number;
  run(now: Date): Promise<MaintenanceTaskResult>;
}

/**
 * The tasks of the `maintenance` queue. A provider registers its task in `onModuleInit`; the maintenance
 * worker upserts one job scheduler for each task in `onApplicationBootstrap` (after all registrations).
 */
@Injectable()
export class MaintenanceTaskRegistry {
  private readonly tasks = new Map<MaintenanceTaskName, MaintenanceTask>();

  register(task: MaintenanceTask): void {
    if (this.tasks.has(task.name)) {
      throw new Error(`Maintenance task ${task.name} is already registered`);
    }
    this.tasks.set(task.name, task);
  }

  get(name: MaintenanceTaskName): MaintenanceTask | undefined {
    return this.tasks.get(name);
  }

  list(): MaintenanceTask[] {
    return [...this.tasks.values()];
  }
}
