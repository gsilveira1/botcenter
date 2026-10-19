import { Global, Module } from '@nestjs/common';
import { InboundHandlerRegistry } from './inbound-handler.registry';
import { InboundIngestService } from './inbound-ingest.service';
import { InboundWorker } from './inbound.worker';
import { InternalWebhookController } from './internal-webhook.controller';

/** API process: the internal provider webhook. */
@Module({
  controllers: [InternalWebhookController],
  providers: [InboundIngestService],
})
export class InboundApiModule {}

/**
 * Worker process: the `inbound` consumer and the handler registry. The registry is global, so the
 * worker modules of wave 2 inject it without an import.
 */
@Global()
@Module({
  providers: [InboundHandlerRegistry, InboundWorker],
  exports: [InboundHandlerRegistry],
})
export class InboundWorkerModule {}
