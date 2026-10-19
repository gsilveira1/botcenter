import { Injectable } from '@nestjs/common';
import type { TimerPlan } from '@botcenter/engine';
import { getLogger } from '../logging/logger';
import { QueuesService } from '../queues/queues.service';
import { AlertService } from '../services/alert.service';
import { ConversationMetrics } from './conversation-metrics';

export const TIMER_JOB_NAME = 'state-timeout';

/**
 * The state timers of the conversations: delayed jobs in the `timers` queue with the deterministic id of
 * the engine (`timer-<conversationId>-v<version>`). Call both methods after the commit of the write that
 * goes with the timer. A late or duplicate timer is safe: `handleTimeout` ignores a stale timer.
 */
@Injectable()
export class ConversationTimersService {
  private readonly logger = getLogger('conversation-timers');

  constructor(
    private readonly queues: QueuesService,
    private readonly alerts: AlertService,
    private readonly metrics: ConversationMetrics,
  ) {}

  /**
   * Adds the timer job. A failure is logged and sent as an alert, and the result is `false`: the
   * `sweep-inbound` job adds the timer again later (ARCH-08).
   */
  async schedule(
    plan: TimerPlan,
    target: { tenantId: string; conversationId: string },
    now: Date,
  ): Promise<boolean> {
    try {
      await this.queues.add(
        'timers',
        TIMER_JOB_NAME,
        {
          tenantId: target.tenantId,
          conversationId: target.conversationId,
          state: plan.state,
          conversationVersion: plan.version,
        },
        { jobId: plan.jobId, delay: Math.max(0, plan.fireAt.getTime() - now.getTime()) },
      );
      this.metrics.timers.inc({ result: 'scheduled' });
      return true;
    } catch (error) {
      this.metrics.timers.inc({ result: 'schedule_failed' });
      this.logger.error(
        { err: error, conversation_id: target.conversationId, timer_job_id: plan.jobId },
        'state timer not scheduled; the sweep adds it again later',
      );
      void this.alerts.notify({
        severity: 'warning',
        title: 'Conversation state timer not scheduled',
        details: { conversation_id: target.conversationId, error: (error as Error).name },
        dedupeKey: 'conversation-timer-schedule',
      });
      return false;
    }
  }

  /** Removes a pending timer job. A failure is only logged: the stale timer is a no-op when it fires. */
  async cancel(jobId: string): Promise<void> {
    try {
      await this.queues.get('timers').remove(jobId);
    } catch (error) {
      this.logger.warn(
        { err: error, timer_job_id: jobId },
        'stale state timer not removed; it is a no-op when it fires',
      );
    }
  }
}
