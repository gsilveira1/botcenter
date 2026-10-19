import { Module } from '@nestjs/common';
import { ExternalHttpModule } from '../external-http/external-http.module';
import { MaintenanceWorkerModule } from '../maintenance/maintenance.module';
import { OutboxDispatcher } from './outbox-dispatcher';
import { OutboxLagCollector } from './outbox-lag';
import {
  DEFAULT_WEBHOOK_DELIVERY_SETTINGS,
  WEBHOOK_DELIVERY_SETTINGS,
} from './webhook-delivery.policy';
import { WebhookDeliveryJobs } from './webhook-delivery.jobs';
import { WebhookDeliveryWorker } from './webhook-delivery.worker';
import { WebhookDeliveriesService } from './webhook-deliveries.service';
import { WebhookSecrets } from './webhook-secrets';
import { WebhookSubscriptionsService } from './webhook-subscriptions.service';
import { WebhookSweepTask } from './webhook-sweep.task';
import { WebhooksController } from './webhooks.controller';

/**
 * API process: the `/v1/webhooks` routes and the outbox lag gauge. `ExternalHttpModule` (global) comes
 * with it, so other slices can inject `EXTERNAL_HTTP`.
 */
@Module({
  imports: [ExternalHttpModule],
  controllers: [WebhooksController],
  providers: [
    WebhookSubscriptionsService,
    WebhookDeliveriesService,
    WebhookSecrets,
    WebhookDeliveryJobs,
    OutboxLagCollector,
  ],
})
export class WebhooksApiModule {}

/**
 * Worker process: the outbox dispatcher loop, the `webhooks` consumer, and the delivery sweep task.
 * It imports `MaintenanceWorkerModule` (the `maintenance` queue) and `ExternalHttpModule`.
 * Tests replace `WEBHOOK_DELIVERY_SETTINGS` (short retry delays and time limit).
 */
@Module({
  imports: [ExternalHttpModule, MaintenanceWorkerModule],
  providers: [
    { provide: WEBHOOK_DELIVERY_SETTINGS, useValue: DEFAULT_WEBHOOK_DELIVERY_SETTINGS },
    WebhookSecrets,
    WebhookDeliveryJobs,
    OutboxDispatcher,
    WebhookDeliveryWorker,
    WebhookSweepTask,
  ],
})
export class WebhooksWorkerModule {}
