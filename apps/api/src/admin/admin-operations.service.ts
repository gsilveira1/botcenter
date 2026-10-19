import { Inject, Injectable } from '@nestjs/common';
import { ProviderError } from '@botcenter/whatsapp-provider';
import type { ProviderWebhookNormalizer } from '@botcenter/whatsapp-provider';
import { AppError, notFound, validationError } from '../common/errors/app-error';
import { inboundJobId, serializeEvent } from '../inbound/inbound-ingest.service';
import { ProviderInstancesService } from '../instances/provider-instances.service';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { PROVIDER_WEBHOOK_NORMALIZER } from '../provider/provider.tokens';
import { QueuesService } from '../queues/queues.service';
import { AuditService } from '../services/audit.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RawEventReplay {
  raw_event_id: string;
  enqueued: number;
  ignored: number;
  /** The ids of the new `inbound` jobs. */
  jobs: string[];
}

export interface WebhookResync {
  total: number;
  succeeded: number;
  /** The ids of the instances that the provider refused or did not answer for. */
  failed: string[];
}

/**
 * The operation commands of the admin CLI: the replay of a raw provider event (ARCH-01 item 3), and the
 * new write of the provider webhook of every instance (for example after a change of
 * `EVOLUTION_WEBHOOK_SECRET`). Each command writes an audit row with the actor `cli:<operator>`.
 */
@Injectable()
export class AdminOperationsService {
  private readonly logger = getLogger('admin');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queues: QueuesService,
    private readonly providerInstances: ProviderInstancesService,
    @Inject(PROVIDER_WEBHOOK_NORMALIZER) private readonly normalizer: ProviderWebhookNormalizer,
  ) {}

  /**
   * Sends a `raw_events` row through the normalizer and the `inbound` queue again, WITHOUT the dedupe
   * check: use it when the inbound job of the event failed or got lost. Each run adds new jobs (a new job
   * id). The inbound handlers are idempotent (a stored message is not stored two times). The job keeps the
   * original receive time, so the bot does not answer a message older than 1 h.
   */
  async replayRawEvent(id: string, actor: string, now = new Date()): Promise<RawEventReplay> {
    if (!UUID.test(id)) {
      throw validationError('Invalid raw event id', [{ path: 'id', message: 'Must be a UUID' }]);
    }
    const raw = await this.prisma.rawEvent.findUnique({ where: { id } });
    if (!raw) {
      throw notFound('Raw event');
    }
    let normalized: ReturnType<ProviderWebhookNormalizer['normalize']>;
    try {
      normalized = this.normalizer.normalize(raw.payload);
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'rejected') {
        throw new AppError('VALIDATION_FAILED', 'The normalizer rejects the raw event body', {
          cause: error,
        });
      }
      throw error;
    }
    const jobs: string[] = [];
    for (const event of normalized.events) {
      const jobId = `${inboundJobId(event.dedupeKey)}-replay-${now.getTime()}`;
      await this.queues.add(
        'inbound',
        event.kind,
        {
          event: serializeEvent(event),
          rawEventId: raw.id,
          receivedAt: raw.receivedAt.toISOString(),
        },
        { jobId },
      );
      jobs.push(jobId);
    }
    const instance = raw.instanceId
      ? await this.prisma.instance.findUnique({
          where: { id: raw.instanceId },
          select: { tenantId: true },
        })
      : null;
    await this.audit.record({
      tenantId: instance?.tenantId ?? null,
      actor,
      action: 'raw_event.replay',
      targetType: 'raw_event',
      targetId: raw.id,
      metadata: {
        kinds: [...new Set(normalized.events.map((event) => event.kind))],
        enqueued: jobs.length,
        ignored: normalized.ignored,
      },
    });
    return { raw_event_id: raw.id, enqueued: jobs.length, ignored: normalized.ignored, jobs };
  }

  /**
   * Calls the idempotent `createInstance` of the provider for every active instance that exists in the
   * provider. It writes the current webhook URL and `EVOLUTION_WEBHOOK_SECRET` again, so a new secret
   * reaches every instance. A provider error of one instance is logged and listed; the run continues.
   */
  async resyncInstanceWebhooks(actor: string): Promise<WebhookResync> {
    const instances = await this.prisma.instance.findMany({
      where: { deletedAt: null, providerCreatedAt: { not: null } },
      select: { id: true, tenantId: true, providerName: true, providerCreatedAt: true },
      orderBy: { id: 'asc' },
    });
    const failed: string[] = [];
    for (const instance of instances) {
      try {
        await this.providerInstances.create(instance);
      } catch (error) {
        if (!(error instanceof ProviderError)) {
          throw error;
        }
        this.logger.warn(
          { err: error, instance_id: instance.id },
          'provider webhook not written again for the instance',
        );
        failed.push(instance.id);
      }
    }
    const result = { total: instances.length, succeeded: instances.length - failed.length, failed };
    await this.audit.record({
      tenantId: null,
      actor,
      action: 'instance.resync_webhook',
      targetType: 'instance',
      targetId: null,
      metadata: { total: result.total, succeeded: result.succeeded, failed },
    });
    return result;
  }
}
