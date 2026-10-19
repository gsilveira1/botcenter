import type { Prisma } from '../generated/prisma/client';

/** One row of `outbox_events` that the dispatcher read. */
export interface OutboxRow {
  id: string;
  tenantId: string;
  type: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
}

/** One active subscription of a tenant of the batch. */
export interface SubscriptionTarget {
  id: string;
  tenantId: string;
  events: string[];
}

/**
 * The delivery rows of a batch of events: one row for each event and each active subscription of the
 * same tenant that asked for the event type. The body is the contracts `WebhookEvent` envelope. The
 * unique key `(subscriptionId, eventId)` makes a second fan-out of the same event a no-op.
 */
export function fanOut(
  events: readonly OutboxRow[],
  subscriptions: readonly SubscriptionTarget[],
  now: Date,
): Prisma.WebhookDeliveryCreateManyInput[] {
  return events.flatMap((event) =>
    subscriptions
      .filter(
        (subscription) =>
          subscription.tenantId === event.tenantId && subscription.events.includes(event.type),
      )
      .map((subscription) => ({
        tenantId: event.tenantId,
        subscriptionId: subscription.id,
        eventId: event.id,
        eventType: event.type,
        payload: {
          id: event.id,
          type: event.type,
          created_at: event.createdAt.toISOString(),
          data: event.payload,
        } as Prisma.InputJsonObject,
        status: 'pending' as const,
        nextAttemptAt: now,
      })),
  );
}
