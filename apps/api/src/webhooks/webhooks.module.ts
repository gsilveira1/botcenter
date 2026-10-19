import { Module } from '@nestjs/common';
import { ExternalHttpModule } from '../external-http/external-http.module';
import { BotWebhookCallsService } from './bot-webhook-calls.service';
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
 * The `call_webhook` rows of the bots and the bot request signature (ARCH-04, SEC-06), for the
 * conversations worker (`createInTx`, `dispatch`, `signedHeaders`) and the bots routes (`WebhookSecrets`).
 * The delivery of the rows is in `WebhooksWorkerModule` (the `webhooks` queue).
 */
@Module({
  providers: [WebhookSecrets, WebhookDeliveryJobs, BotWebhookCallsService],
  exports: [WebhookSecrets, BotWebhookCallsService],
})
export class BotWebhookCallsModule {}

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
 * Worker process: the outbox dispatcher loop, the `webhooks` consumer (webhook deliveries and bot calls),
 * and the delivery sweep task.
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
