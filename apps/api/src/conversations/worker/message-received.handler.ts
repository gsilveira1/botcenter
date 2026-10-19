import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { InboundHandlerRegistry } from '../../inbound/inbound-handler.registry';
import type {
  InboundHandler,
  InboundJobContext,
  ProviderEventOf,
} from '../../inbound/inbound-handler.registry';
import { bindLogContext } from '../../logging/log-context';
import { getLogger } from '../../logging/logger';
import { ConversationMetrics } from '../conversation-metrics';
import { ConversationRuntime } from './conversation-runtime.service';
import { InboundStoreService } from './inbound-store.service';
import { InstanceResolver } from './instance-context';

/**
 * The worker handler of `message.received` (architecture: "Recebimento de mensagem"):
 * 1. store the message, its media, and the `message.received` event (always);
 * 2. when the instance has a bot and the conversation is not in handoff, run the bot step under the
 *    lock of the conversation.
 */
@Injectable()
export class MessageReceivedHandler implements InboundHandler<'message.received'>, OnModuleInit {
  private readonly logger = getLogger('message-received');

  constructor(
    private readonly registry: InboundHandlerRegistry,
    private readonly instances: InstanceResolver,
    private readonly store: InboundStoreService,
    private readonly runtime: ConversationRuntime,
    private readonly metrics: ConversationMetrics,
  ) {}

  onModuleInit(): void {
    this.registry.register('message.received', this);
  }

  async handle(
    event: ProviderEventOf<'message.received'>,
    context: InboundJobContext,
  ): Promise<void> {
    const instance = await this.instances.byProviderName(event.instanceName);
    if (!instance) {
      this.metrics.skipped.inc({ reason: 'unknown_instance' });
      this.logger.warn(
        { provider_instance: event.instanceName },
        'inbound message for an unknown or deleted instance; the job ends',
      );
      return;
    }
    bindLogContext({ tenant_id: instance.tenantId, instance_id: instance.instanceId });
    const stored = await this.store.store(instance, event, context.receivedAt);
    if (stored.botPending) {
      await this.runtime.drain(instance, stored.contact);
    }
  }
}
