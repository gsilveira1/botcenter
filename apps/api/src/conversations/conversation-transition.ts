import type { TransitionTrigger } from '@botcenter/contracts';
import type { TransactionClient } from '../prisma/prisma.service';
import type { OutboxService } from '../services/outbox.service';

export interface TransitionInput {
  tenantId: string;
  conversationId: string;
  instanceId: string;
  /** `external_ref` of the instance owner (every event has it). */
  externalRef: string;
  contact: string;
  botSlug: string;
  botVersion: number;
  fromState: string | null;
  toState: string;
  trigger: TransitionTrigger;
  handoff: boolean;
}

/**
 * Writes one `conversation_transitions` row and its `conversation.transitioned` outbox event in the
 * transaction of the conversation write. The worker (engine steps) and the handoff route use it.
 */
export async function recordTransition(
  tx: TransactionClient,
  outbox: OutboxService,
  input: TransitionInput,
): Promise<void> {
  await tx.conversationTransition.create({
    data: {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      fromState: input.fromState,
      toState: input.toState,
      trigger: input.trigger,
    },
  });
  await outbox.enqueue(tx, {
    tenantId: input.tenantId,
    type: 'conversation.transitioned',
    payload: {
      instance_id: input.instanceId,
      external_ref: input.externalRef,
      conversation_id: input.conversationId,
      contact: input.contact,
      bot_id: input.botSlug,
      bot_version: input.botVersion,
      from_state: input.fromState,
      to_state: input.toState,
      trigger: input.trigger,
      handoff: input.handoff,
    },
  });
}
