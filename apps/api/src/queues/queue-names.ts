import type { ProviderEvent } from '@botcenter/whatsapp-provider';

/**
 * The BullMQ queues and the payload type of each queue (plan, section 4). A payload is JSON: use ids
 * and ISO strings, never `Date` objects or message content that the worker can read from the database.
 * Wave 2 slices can add fields or job names here (additive edits only).
 */
export const QUEUE_NAMES = ['outbound', 'inbound', 'webhooks', 'timers', 'maintenance'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** `outbound`: send one message (messages slice). */
export interface OutboundJob {
  tenantId: string;
  messageId: string;
  instanceId: string;
}

/** A provider event in a job: `occurredAt` is an ISO string. The inbound worker makes it a `Date` again. */
export type SerializedProviderEvent = {
  [K in ProviderEvent['kind']]: Omit<Extract<ProviderEvent, { kind: K }>, 'occurredAt'> & {
    occurredAt: string;
  };
}[ProviderEvent['kind']];

/** `inbound`: one normalized provider event (internal webhook). */
export interface InboundJob {
  event: SerializedProviderEvent;
  /** Row of `raw_events`, when the store succeeded. */
  rawEventId: string | null;
  receivedAt: string;
}

/** `webhooks`: deliver one webhook delivery row (webhooks slice). */
export interface WebhookJob {
  tenantId: string;
  deliveryId: string;
}

/** `timers`: a state timeout of a conversation (conversations slice). The job id is deterministic. */
export interface TimerJob {
  tenantId: string;
  conversationId: string;
  /** The state that the timer belongs to. The handler ignores the job when the state changed. */
  state: string;
  /** `conversations.version` when the timer started. */
  conversationVersion: number;
}

/** `maintenance`: scheduled cleanup and dispatch tasks (webhooks slice owns the schedulers). */
export interface MaintenanceJob {
  task:
    | 'purge-raw-events'
    | 'purge-messages'
    | 'purge-idempotency-keys'
    | 'purge-connect-tokens'
    | 'dispatch-outbox';
}

export interface JobPayloads {
  outbound: OutboundJob;
  inbound: InboundJob;
  webhooks: WebhookJob;
  timers: TimerJob;
  maintenance: MaintenanceJob;
}

/** Concurrency of each queue in the worker process (environment variables). */
export const CONCURRENCY_ENV: Record<QueueName, string> = {
  outbound: 'WORKER_CONCURRENCY_OUTBOUND',
  inbound: 'WORKER_CONCURRENCY_INBOUND',
  webhooks: 'WORKER_CONCURRENCY_WEBHOOKS',
  timers: 'WORKER_CONCURRENCY_TIMERS',
  maintenance: 'WORKER_CONCURRENCY_MAINTENANCE',
};
