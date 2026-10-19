import { Global, Module } from '@nestjs/common';
import { BatchPurger } from './batch-purger';
import { IncidentService } from './incident.service';
import { MaintenanceTaskRegistry } from './maintenance-task.registry';
import { MaintenanceWorker } from './maintenance.worker';
import { MediaModule } from '../media/media.module';
import { MediaPurgeTask } from './media-purge.task';
import { OperationalAlertsTask } from './operational-alerts.task';
import { PurgeTasks } from './purge.tasks';

/**
 * Worker process: the `maintenance` queue (purges for LGPD, operational alerts) and its job schedulers.
 * The task registry is global, so another worker module can register a task (`MaintenanceTaskRegistry`).
 */
@Global()
@Module({
  imports: [MediaModule],
  providers: [
    MaintenanceTaskRegistry,
    MaintenanceWorker,
    BatchPurger,
    IncidentService,
    PurgeTasks,
    MediaPurgeTask,
    OperationalAlertsTask,
  ],
  exports: [MaintenanceTaskRegistry, IncidentService],
})
export class MaintenanceWorkerModule {}
