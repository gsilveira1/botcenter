import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ProviderError } from '@botcenter/whatsapp-provider';
import type { ProviderEvent, ProviderWebhookNormalizer } from '@botcenter/whatsapp-provider';
import type { Redis } from 'ioredis';
import { AppError } from '../common/errors/app-error';
import type { Prisma } from '../generated/prisma/client';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { PROVIDER_WEBHOOK_NORMALIZER } from '../provider/provider.tokens';
import { QueuesService } from '../queues/queues.service';
import type { SerializedProviderEvent } from '../queues/queue-names';
import { redisKeys } from '../redis/redis-keys';
import { REDIS } from '../redis/redis.module';
import { AlertService } from '../services/alert.service';

export const DEDUPE_TTL_SECONDS = 86_400;

export interface IngestResult {
  received: number;
  enqueued: number;
  duplicates: number;
  ignored: number;
}

/** BullMQ job ids cannot contain `:`. The id is a hash of the dedupe key, so equal events have equal ids. */
export function inboundJobId(dedupeKey: string): string {
  return `in-${createHash('sha256').update(dedupeKey).digest('hex')}`;
}

/**
 * PostgreSQL `jsonb` refuses the character U+0000. The stored copy is for debugging only, so the
 * function removes the character instead of a 500 on each retry of the provider.
 */
export function withoutNul(body: unknown): Prisma.InputJsonValue {
  const text = JSON.stringify(body ?? null);
  // `\u0000` after an even number of backslashes is the escape of U+0000, not a literal text.
  const cleaned = text.includes('\\u0000')
    ? text.replace(/(?<!\\)((?:\\\\)*)\\u0000/g, '$1')
    : text;
  return JSON.parse(cleaned) as Prisma.InputJsonValue;
}

export function serializeEvent(event: ProviderEvent): SerializedProviderEvent {
  return { ...event, occurredAt: event.occurredAt.toISOString() } as SerializedProviderEvent;
}

/**
 * The work of `POST /internal/evolution/webhook`: normalize the body, keep the raw body in `raw_events`
 * (7 days, for debugging), drop duplicate events (Redis `SET NX EX 86400` on the dedupe key), and put each
 * new event in the `inbound` queue. The route answers at once; the workers do the slow work.
 * Answers (Evolution v2.3.7 retries a 5xx, not a 400 or a 401):
 * - 200: the raw body is stored and each new event is queued (or is a duplicate);
 * - 400 `VALIDATION_FAILED`: the normalizer rejected the body;
 * - 500 `INTERNAL`: PostgreSQL or Redis failed, so the provider sends the webhook again.
 */
@Injectable()
export class InboundIngestService {
  private readonly logger = getLogger('inbound');

  constructor(
    @Inject(PROVIDER_WEBHOOK_NORMALIZER) private readonly normalizer: ProviderWebhookNormalizer,
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly queues: QueuesService,
    private readonly metrics: MetricsService,
    private readonly alerts: AlertService,
  ) {}

  async ingest(body: unknown, now = new Date()): Promise<IngestResult> {
    let normalized: { events: ProviderEvent[]; ignored: number };
    try {
      normalized = this.normalizer.normalize(body);
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'rejected') {
        // Evolution does not retry a 400, so the answer does not cause a loop. The raw body stays for the
        // operators when the database accepts it.
        this.logger.warn({ err: error }, 'provider webhook body rejected by the normalizer');
        this.metrics.inboundEventsTotal.inc({ result: 'rejected' });
        await this.storeRejected(body, now);
        throw new AppError('VALIDATION_FAILED', 'The provider webhook body is not valid', {
          cause: error,
        });
      }
      throw error;
    }

    const { events, ignored } = normalized;
    if (ignored > 0) {
      this.metrics.inboundEventsTotal.inc({ result: 'ignored' }, ignored);
    }
    const kinds = [...new Set(events.map((event) => event.kind))];
    const instanceId = await this.findInstanceId(events[0]?.instanceName);
    const rawEventId = await this.storeRaw(
      body,
      kinds.length > 0 ? kinds.join(',') : 'ignored',
      instanceId,
      now,
    );

    let enqueued = 0;
    let duplicates = 0;
    for (const event of events) {
      if (await this.enqueue(event, rawEventId, now)) {
        enqueued += 1;
      } else {
        duplicates += 1;
      }
    }
    if (enqueued > 0) {
      this.metrics.inboundEventsTotal.inc({ result: 'enqueued' }, enqueued);
    }
    if (duplicates > 0) {
      this.metrics.inboundEventsTotal.inc({ result: 'duplicate' }, duplicates);
    }
    return { received: events.length, enqueued, duplicates, ignored };
  }

  /** Returns false for a duplicate. Throws (500, the provider retries) when the event cannot be queued. */
  private async enqueue(event: ProviderEvent, rawEventId: string, now: Date): Promise<boolean> {
    const dedupeKey = redisKeys.inboundDedupe(event.dedupeKey);
    try {
      const first = await this.redis.set(dedupeKey, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX');
      if (first !== 'OK') {
        return false;
      }
      await this.queues.add(
        'inbound',
        event.kind,
        { event: serializeEvent(event), rawEventId, receivedAt: now.toISOString() },
        { jobId: inboundJobId(event.dedupeKey) },
      );
      return true;
    } catch (error) {
      // Free the dedupe key, so that the retry of the provider is not dropped as a duplicate.
      await this.redis.del(dedupeKey).catch((cleanupError: unknown) => {
        this.logger.error({ err: cleanupError }, 'dedupe key not freed after a failed enqueue');
      });
      this.logger.error({ err: error, kind: event.kind }, 'inbound event not queued');
      void this.alerts.notify({
        severity: 'critical',
        title: 'Inbound provider event not queued',
        details: { kind: event.kind, error: error instanceof Error ? error.name : 'error' },
        dedupeKey: 'inbound:enqueue',
      });
      throw new AppError('INTERNAL', 'The event was not queued', { cause: error });
    }
  }

  private async findInstanceId(providerName: string | undefined): Promise<string | null> {
    if (!providerName) {
      return null;
    }
    try {
      const instance = await this.prisma.instance.findUnique({
        where: { providerName },
        select: { id: true },
      });
      return instance?.id ?? null;
    } catch (error) {
      this.logger.warn({ err: error }, 'instance lookup for the raw event failed');
      return null;
    }
  }

  /**
   * Stores the raw body (7 days, for debugging). A store error is a 500: Evolution retries the webhook,
   * so the answer 200 always means "stored and queued".
   */
  private async storeRaw(
    body: unknown,
    eventType: string,
    instanceId: string | null,
    now: Date,
  ): Promise<string> {
    try {
      const row = await this.prisma.rawEvent.create({
        data: {
          instanceId,
          eventType,
          payload: withoutNul(body),
          receivedAt: now,
        },
        select: { id: true },
      });
      return row.id;
    } catch (error) {
      this.logger.error({ err: error, event_type: eventType }, 'raw provider event not stored');
      void this.alerts.notify({
        severity: 'critical',
        title: 'Provider webhook refused: raw event not stored',
        details: { error: error instanceof Error ? error.name : 'error' },
        dedupeKey: 'inbound:raw-event',
      });
      throw new AppError('INTERNAL', 'The event was not stored', { cause: error });
    }
  }

  /** A rejected body is kept when possible. Its store error does not change the 400. */
  private async storeRejected(body: unknown, now: Date): Promise<void> {
    try {
      await this.storeRaw(body, 'rejected', null, now);
    } catch (error) {
      this.logger.warn({ err: error }, 'rejected provider body not stored');
    }
  }
}
