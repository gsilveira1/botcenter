import { randomUUID } from 'node:crypto';
import { EvolutionWebhookNormalizer } from '@botcenter/whatsapp-provider';
import {
  newMessageId,
  updateData,
  upsertData,
  webhookEnvelope,
} from '@botcenter/whatsapp-provider/testing';
import type { EvolutionAckStatus } from '@botcenter/whatsapp-provider/testing';

/**
 * The provider fakes of the integration tests. The harness binds `FakeWhatsAppProvider` (in memory) and
 * the real `EvolutionWebhookNormalizer`, so a test posts real Evolution v2.3.7 webhook bodies to
 * `POST /internal/evolution/webhook`. The builders below make these bodies.
 */
export { FakeEvolutionServer, FakeWhatsAppProvider } from '@botcenter/whatsapp-provider/testing';

const ENVELOPE = {
  destination: 'http://api.test:3000/internal/evolution/webhook',
  serverUrl: 'http://evolution.test:8080',
};

/** The Evolution instance id (`instanceId` in `data`). The Bot Center does not read it. */
const EVOLUTION_INSTANCE_ID = randomUUID();

const normalizer = new EvolutionWebhookNormalizer();

/** An Evolution webhook body and the dedupe key that the normalizer gives to its event. */
export interface EvolutionWebhook {
  body: Record<string, unknown>;
  /** `ProviderEvent.dedupeKey` of the event. `inboundJobId(dedupeKey)` is the id of its inbound job. */
  dedupeKey: string;
}

function withDedupeKey(body: Record<string, unknown>): EvolutionWebhook {
  const [event] = normalizer.normalize(body).events;
  if (!event) {
    throw new Error('The Evolution normalizer ignored the test webhook body');
  }
  return { body, dedupeKey: event.dedupeKey };
}

export interface InboundTextInput {
  /** The `providerName` of the instance (`inst_<uuid>`). */
  instanceName: string;
  text?: string;
  /** The phone of the contact (E.164 digits). */
  from?: string;
  /** The WhatsApp message id. A second body with the same id is a duplicate. */
  id?: string;
  timestamp?: Date;
}

/** A `messages.upsert` webhook with a text message from a contact (`message.received`, type `text`). */
export function evolutionInboundText(
  input: InboundTextInput,
): EvolutionWebhook & { messageId: string } {
  const messageId = input.id ?? newMessageId();
  const data = upsertData({ conversation: input.text ?? 'Oi' }, 'conversation', {
    from: input.from ?? '5511987654321',
    id: messageId,
    instanceId: EVOLUTION_INSTANCE_ID,
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
  });
  return {
    ...withDedupeKey(webhookEnvelope('messages.upsert', input.instanceName, data, ENVELOPE)),
    messageId,
  };
}

export interface StatusInput {
  instanceName: string;
  /** The `providerMessageId` of a message that the instance sent. */
  messageId: string;
  status: EvolutionAckStatus;
  /** The phone of the recipient. */
  to?: string;
}

/** A `messages.update` webhook for a sent message (`message.status`). `DELIVERY_ACK` is `delivered`. */
export function evolutionStatus(input: StatusInput): EvolutionWebhook {
  const data = updateData(
    input.messageId,
    input.to ?? '5511987654321',
    input.status,
    EVOLUTION_INSTANCE_ID,
  );
  return withDedupeKey(webhookEnvelope('messages.update', input.instanceName, data, ENVELOPE));
}
