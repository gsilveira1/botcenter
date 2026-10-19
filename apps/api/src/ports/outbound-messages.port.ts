import type { MessageContent, MessagePriority } from '@botcenter/contracts';
import type { TransactionClient } from '../prisma/prisma.service';

/**
 * Frozen port between the conversations slice (caller) and the messages slice (implementation).
 * The conversations slice writes bot replies in the same transaction as the conversation state,
 * then dispatches them after the commit.
 */
export const OUTBOUND_MESSAGES = Symbol('OUTBOUND_MESSAGES');

export interface OutboundMessageInput {
  tenantId: string;
  instanceId: string;
  /** E.164 digits without the `+` sign. */
  to: string;
  content: MessageContent;
  priority: MessagePriority;
  conversationId?: string;
  /** The provider shows "typing" for this time before the send (ban mitigation for bot replies). */
  typingDelayMs?: number;
}

export interface OutboundMessagesPort {
  /**
   * Writes one `messages` row with status `queued` in the transaction of the caller. It does not check the
   * daily quota of the tenant for `priority: 'reply'` (a bot reply to a user message is never refused).
   */
  createInTx(tx: TransactionClient, input: OutboundMessageInput): Promise<{ messageId: string }>;
  /**
   * Adds one `outbound` job for each message after the commit. Idempotent: the job id is the message id.
   * When Redis fails, it logs the error and leaves the rows `queued`; a sweep of the messages slice sends them later.
   */
  dispatch(
    messages: ReadonlyArray<{ tenantId: string; messageId: string; instanceId: string }>,
  ): Promise<void>;
}
