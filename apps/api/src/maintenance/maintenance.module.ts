import { Global, Module } from '@nestjs/common';
import { BatchPurger } from './batch-purger';
import { MaintenanceTaskRegistry } from './maintenance-task.registry';
import { MaintenanceWorker } from './maintenance.worker';
import { MEDIA_OBJECT_STORE, MediaPurgeTask, S3MediaObjectStore } from './media-purge.task';
import { PurgeTasks } from './purge.tasks';

/**
 * Worker process: the `maintenance` queue (purges for LGPD) and its job schedulers.
 * The task registry is global, so another worker module can register a task (`MaintenanceTaskRegistry`).
 * Tests replace `MEDIA_OBJECT_STORE`.
 */
@Global()
@Module({
  providers: [
    MaintenanceTaskRegistry,
    MaintenanceWorker,
    BatchPurger,
    PurgeTasks,
    MediaPurgeTask,
    { provide: MEDIA_OBJECT_STORE, useClass: S3MediaObjectStore },
  ],
  exports: [MaintenanceTaskRegistry],
})
export class MaintenanceWorkerModule {}
