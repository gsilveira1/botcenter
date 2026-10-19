import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { ProviderEvent } from '@botcenter/whatsapp-provider';
import type { Job } from 'bullmq';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import type { InboundJob } from '../queues/queue-names';
import { WorkerFactory } from '../queues/worker.factory';
import { InboundHandlerRegistry } from './inbound-handler.registry';

export function reviveEvent(serialized: InboundJob['event']): ProviderEvent {
  return { ...serialized, occurredAt: new Date(serialized.occurredAt) } as ProviderEvent;
}

/**
 * The consumer of the `inbound` queue. It sends each event to the handler of its kind. An event without a
 * handler is logged at `warn`, counted (`botcenter_inbound_events_total{result="unhandled"}`), and the job
 * ends. The order of the events of one conversation is the work of the handler (lock per conversation).
 */
@Injectable()
export class InboundWorker implements OnApplicationBootstrap {
  private readonly logger = getLogger('inbound-worker');

  constructor(
    private readonly workers: WorkerFactory,
    private readonly registry: InboundHandlerRegistry,
    private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    // Bootstrap runs after every `onModuleInit`, so all the handlers are registered here.
    this.logger.info({ kinds: this.registry.kinds() }, 'inbound handlers registered');
    this.workers.create('inbound', (job) => this.process(job));
  }

  async process(job: Job<InboundJob>): Promise<{ handled: boolean }> {
    const event = reviveEvent(job.data.event);
    const handler = this.registry.get(event.kind);
    if (!handler) {
      this.logger.warn(
        { kind: event.kind },
        'no inbound handler for this event kind; the job ends',
      );
      this.metrics.inboundEventsTotal.inc({ result: 'unhandled' });
      return { handled: false };
    }
    await handler.handle(event as never, {
      jobId: job.id ?? '',
      attemptsMade: job.attemptsMade,
      rawEventId: job.data.rawEventId,
      receivedAt: new Date(job.data.receivedAt),
    });
    return { handled: true };
  }
}
