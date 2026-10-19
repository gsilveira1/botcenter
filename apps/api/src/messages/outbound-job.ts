import type { MessagePriority } from '@botcenter/contracts';
import type { JobsOptions } from 'bullmq';
import { OUTBOUND_MAX_ATTEMPTS } from './retry-policy';

/** Job names of the `outbound` queue. */
export const OUTBOUND_SEND_JOB = 'send';
export const OUTBOUND_SWEEP_JOB = 'sweep';
/** The id of the job scheduler of the sweep (one for the queue). */
export const OUTBOUND_SWEEP_SCHEDULER = 'outbound-sweep';
export const OUTBOUND_SWEEP_EVERY_MS = 60_000;
/** The custom backoff type (`outboundBackoff` in `retry-policy.ts`). */
export const OUTBOUND_BACKOFF_TYPE = 'outbound';

/**
 * BullMQ priority: a lower number goes first. A reply to a user goes before a bulk send
 * (plan, section "Performance"). A job without a priority (the sweep) goes before both.
 */
export const JOB_PRIORITY: Readonly<Record<MessagePriority, number>> = { reply: 1, bulk: 10 };

/** A message to enqueue. */
export interface OutboundEnqueue {
  tenantId: string;
  messageId: string;
  instanceId: string;
  priority: MessagePriority;
}

/** The job id is the message id, so a second add of the same message does nothing (idempotent). */
export function outboundJobOptions(messageId: string, priority: MessagePriority): JobsOptions {
  return {
    jobId: messageId,
    priority: JOB_PRIORITY[priority],
    attempts: OUTBOUND_MAX_ATTEMPTS,
    backoff: { type: OUTBOUND_BACKOFF_TYPE },
  };
}
