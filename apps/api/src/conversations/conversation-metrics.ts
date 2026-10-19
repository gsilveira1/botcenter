import { Injectable } from '@nestjs/common';
import type { Counter } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service';

/**
 * The metrics of the conversations slice. Inbound messages use the shared
 * `botcenter_messages_total{status="received"}`. The other names are new and belong to this slice.
 */
@Injectable()
export class ConversationMetrics {
  /** Moves of a conversation by trigger (`start`, `message`, `timeout`, `handoff`). */
  readonly transitions: Counter<'trigger'>;
  /** Engine diagnostics by severity and code. */
  readonly diagnostics: Counter<'severity' | 'code'>;
  /** Lock of a conversation: `acquired`, or `busy` (the job runs again after a short delay). */
  readonly lockWaits: Counter<'result'>;
  /** Optimistic write conflicts (`version` changed), and steps that failed after the last retry. */
  readonly conflicts: Counter<'result'>;
  /** Hot cache reads and writes: `hit`, `miss`, `error`. */
  readonly cache: Counter<'result'>;
  /** Inbound media files: `stored`, `failed`, `too_large`. */
  readonly inboundMedia: Counter<'result'>;
  /** State timers: `scheduled`, `fired`, `stale`, `schedule_failed`. */
  readonly timers: Counter<'result'>;
  /** `call_webhook` actions: `succeeded`, `failed`. */
  readonly botWebhooks: Counter<'result'>;
  /** Inbound messages that the bot step did not run for: `handoff`, `no_bot`, `stale`, `engine_error`. */
  readonly skipped: Counter<'reason'>;
  /**
   * Lost work that the `sweep-inbound` job repaired (ARCH-01, ARCH-08): `pending_drained`,
   * `pending_dropped`, `timer_rearmed`, `timer_cleared`. A value above zero shows an earlier failure.
   */
  readonly repairs: Counter<'kind'>;

  constructor(private readonly metrics: MetricsService) {
    this.transitions = metrics.counter({
      name: 'botcenter_conversation_transitions_total',
      help: 'Conversation transitions by trigger',
      labelNames: ['trigger'],
    });
    this.diagnostics = metrics.counter({
      name: 'botcenter_engine_diagnostics_total',
      help: 'Engine diagnostics by severity and code',
      labelNames: ['severity', 'code'],
    });
    this.lockWaits = metrics.counter({
      name: 'botcenter_conversation_lock_total',
      help: 'Conversation lock attempts by result',
      labelNames: ['result'],
    });
    this.conflicts = metrics.counter({
      name: 'botcenter_conversation_conflicts_total',
      help: 'Optimistic write conflicts of conversations',
      labelNames: ['result'],
    });
    this.cache = metrics.counter({
      name: 'botcenter_conversation_cache_total',
      help: 'Hot cache operations of conversations by result',
      labelNames: ['result'],
    });
    this.inboundMedia = metrics.counter({
      name: 'botcenter_inbound_media_total',
      help: 'Inbound media files by result',
      labelNames: ['result'],
    });
    this.timers = metrics.counter({
      name: 'botcenter_conversation_timers_total',
      help: 'Conversation state timers by result',
      labelNames: ['result'],
    });
    this.botWebhooks = metrics.counter({
      name: 'botcenter_bot_webhook_calls_total',
      help: 'call_webhook actions of the bots by result',
      labelNames: ['result'],
    });
    this.skipped = metrics.counter({
      name: 'botcenter_conversation_skipped_total',
      help: 'Inbound messages that the bot step did not run for, by reason',
      labelNames: ['reason'],
    });
    this.repairs = metrics.counter({
      name: 'botcenter_inbound_repairs_total',
      help: 'Lost inbound work that the sweep-inbound job repaired, by kind',
      labelNames: ['kind'],
    });
  }

  inboundMessage(): void {
    this.metrics.messagesTotal.inc({ status: 'received' });
  }
}
