import type { MessageStatus } from '@botcenter/contracts';

/** The order of the outbound lifecycle. `failed` is outside the order. */
const RANK: Readonly<Record<Exclude<MessageStatus, 'failed'>, number>> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

/** `failed` can follow only these statuses: a delivered or read message did not fail. */
const FAILED_FROM: readonly MessageStatus[] = ['queued', 'sent'];

/**
 * The status of an outbound message moves only forward: `queued` < `sent` < `delivered` < `read`.
 * `failed` is final and follows only `queued` or `sent`. The provider events can arrive late, two times,
 * or in a different order; this rule makes their effect independent of the order.
 */
export function canMoveStatus(from: MessageStatus, to: MessageStatus): boolean {
  if (from === 'failed') {
    return false;
  }
  if (to === 'failed') {
    return FAILED_FROM.includes(from);
  }
  return RANK[to] > RANK[from];
}

/** The statuses from which `to` is a valid move (the `WHERE status IN (...)` of the update). */
export function statusesBefore(to: MessageStatus): MessageStatus[] {
  return (['queued', 'sent', 'delivered', 'read', 'failed'] as const).filter((from) =>
    canMoveStatus(from, to),
  );
}
