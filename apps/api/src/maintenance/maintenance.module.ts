import { Global, Module } from '@nestjs/common';
import { BatchPurger } from './batch-purger';
import { IncidentService } from './incident.service';
import { MaintenanceTaskRegistry } from './maintenance-task.registry';
import { MaintenanceWorker } from './maintenance.worker';
import { MEDIA_OBJECT_STORE, MediaPurgeTask, S3MediaObjectStore } from './media-purge.task';
import { OperationalAlertsTask } from './operational-alerts.task';
import { PurgeTasks } from './purge.tasks';

/**
 * Worker process: the `maintenance` queue (purges for LGPD, operational alerts) and its job schedulers.
 * The task registry is global, so another worker module can register a task (`MaintenanceTaskRegistry`).
 * Tests replace `MEDIA_OBJECT_STORE`.
 */
@Global()
@Module({
  providers: [
    MaintenanceTaskRegistry,
    MaintenanceWorker,
    BatchPurger,
    IncidentService,
    PurgeTasks,
    MediaPurgeTask,
    OperationalAlertsTask,
    { provide: MEDIA_OBJECT_STORE, useClass: S3MediaObjectStore },
  ],
  exports: [MaintenanceTaskRegistry, IncidentService],
})
export class MaintenanceWorkerModule {}
