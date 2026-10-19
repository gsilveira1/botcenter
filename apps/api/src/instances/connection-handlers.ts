import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { InboundHandlerRegistry } from '../inbound/inbound-handler.registry';
import type { InboundHandler, ProviderEventOf } from '../inbound/inbound-handler.registry';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectChannelService } from './connect-channel.service';
import { codeEvents } from './connect-events';
import { statusFromProvider } from './instance-status';
import { InstanceStatusService } from './instance-status.service';

/**
 * `qrcode.updated`: caches the new code of the instance and publishes it to the open connect streams.
 * A code for a deleted or connected instance is stale and is dropped. A Redis error retries the job.
 */
@Injectable()
export class QrcodeUpdatedHandler implements InboundHandler<'qrcode.updated'>, OnModuleInit {
  private readonly logger = getLogger('qrcode-handler');

  constructor(
    private readonly registry: InboundHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly channel: ConnectChannelService,
  ) {}

  onModuleInit(): void {
    this.registry.register('qrcode.updated', this);
  }

  async handle(event: ProviderEventOf<'qrcode.updated'>): Promise<void> {
    const instance = await this.prisma.instance.findFirst({
      where: { providerName: event.instanceName, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!instance) {
      this.logger.warn(
        { provider_name: event.instanceName },
        'qrcode event for an unknown instance; dropped',
      );
      return;
    }
    if (instance.status === 'connected') {
      this.logger.info(
        { instance_id: instance.id },
        'qrcode event for a connected instance; dropped',
      );
      return;
    }
    const events = codeEvents(event);
    if (events.length === 0) {
      this.logger.warn({ instance_id: instance.id }, 'qrcode event without a valid code; dropped');
      return;
    }
    await this.channel.publishCodes(instance.id, events);
  }
}

/**
 * `connection.updated`: applies the provider state to the instance status (`InstanceStatusService`:
 * stale and duplicate events change nothing and write no event).
 */
@Injectable()
export class ConnectionUpdatedHandler
  implements InboundHandler<'connection.updated'>, OnModuleInit
{
  private readonly logger = getLogger('connection-handler');

  constructor(
    private readonly registry: InboundHandlerRegistry,
    private readonly statuses: InstanceStatusService,
  ) {}

  onModuleInit(): void {
    this.registry.register('connection.updated', this);
  }

  async handle(event: ProviderEventOf<'connection.updated'>): Promise<void> {
    const result = await this.statuses.transition(
      { providerName: event.instanceName },
      {
        next: statusFromProvider(event.state),
        phone: event.phone,
        providerEventAt: event.occurredAt,
      },
    );
    if (result.kind === 'missing') {
      this.logger.warn(
        { provider_name: event.instanceName },
        'connection event for an unknown instance; dropped',
      );
    } else if (result.kind === 'stale') {
      this.logger.info(
        { instance_id: result.instance.id, state: event.state },
        'connection event older than the stored state; dropped',
      );
    }
  }
}
