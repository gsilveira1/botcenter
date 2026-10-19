import { Module } from '@nestjs/common';
import { MaintenanceWorkerModule } from './maintenance/maintenance.module';
import { WebhooksWorkerModule } from './webhooks/webhooks.module';
import { InstancesWorkerModule } from './instances/instances.module';
import { CoreModule } from './core/core.module';
import { WorkerCoreModule } from './core/worker-core.module';
import { InboundWorkerModule } from './inbound/inbound.module';
import { MessagesWorkerModule } from './messages/messages.module';

/**
 * Root module of the worker process (`ROLE=worker`, `src/worker.ts`). No HTTP routes.
 * Only the orchestrator edits this file: it adds the `*WorkerModule` of each wave 2 slice to `imports`.
 */
@Module({
  imports: [
    CoreModule,
    WorkerCoreModule,
    InboundWorkerModule,
    MessagesWorkerModule,
    InstancesWorkerModule,
    WebhooksWorkerModule,
    MaintenanceWorkerModule,
  ],
})
export class WorkerModule {}
