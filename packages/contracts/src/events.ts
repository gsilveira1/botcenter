import { z } from 'zod';
import { StateId } from './bot-definition.js';
import { BotId, IsoDateTime, MaskedPhoneNumber, PhoneNumber, Uuid } from './common.js';
import { TransitionTrigger } from './conversations.js';
import { ExternalRef, InstanceStatus } from './instances.js';
import { MessageStatus } from './messages.js';

/** Events that a client receives through its webhooks. */
export const EVENT_TYPES = [
  'message.received',
  'message.status',
  'conversation.transitioned',
  'instance.status',
] as const;
export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

/** Every event has the instance and the `external_ref` of its owner (architecture plan, section "Regras"). */
const instanceShape = {
  instance_id: Uuid,
  external_ref: ExternalRef,
};

/**
 * Type of an inbound message:
 * `button_reply` and `list_reply` are clicks on a button or a list row; `unsupported` is a type that
 * Bot Center does not read (for example, a sticker or a location).
 */
export const INBOUND_MESSAGE_TYPES = [
  'text',
  'media',
  'button_reply',
  'list_reply',
  'unsupported',
] as const;
export const InboundMessageType = z.enum(INBOUND_MESSAGE_TYPES);
export type InboundMessageType = z.infer<typeof InboundMessageType>;

/** Inbound media in the object storage. `url` is a signed GET URL that expires at `expires_at`. */
export const InboundMedia = z.object({
  media_id: Uuid,
  mime_type: z.string().min(1).max(127),
  url: z.url(),
  expires_at: IsoDateTime,
});
export type InboundMedia = z.infer<typeof InboundMedia>;

/**
 * `message.received`. `from` is the full number of the contact, so that the client can answer.
 * `conversation_id` is present when a bot serves the instance.
 */
export const MessageReceivedData = z.object({
  ...instanceShape,
  message_id: Uuid,
  from: PhoneNumber,
  type: InboundMessageType,
  text: z.string().optional(),
  button_id: z.string().optional(),
  list_row_id: z.string().optional(),
  media: InboundMedia.optional(),
  conversation_id: Uuid.optional(),
});
export type MessageReceivedData = z.infer<typeof MessageReceivedData>;

/** `message.status`: a new status of an outbound message. */
export const MessageStatusData = z.object({
  ...instanceShape,
  message_id: Uuid,
  status: MessageStatus,
  failure_reason: z.string().nullable(),
});
export type MessageStatusData = z.infer<typeof MessageStatusData>;

/** `conversation.transitioned`: the bot moved a conversation to a new state. */
export const ConversationTransitionedData = z.object({
  ...instanceShape,
  conversation_id: Uuid,
  contact: PhoneNumber,
  bot_id: BotId,
  bot_version: z.number().int().min(1),
  from_state: StateId.nullable(),
  to_state: StateId,
  trigger: TransitionTrigger,
  handoff: z.boolean(),
});
export type ConversationTransitionedData = z.infer<typeof ConversationTransitionedData>;

/** `instance.status`: a new lifecycle status of an instance. */
export const InstanceStatusData = z.object({
  ...instanceShape,
  status: InstanceStatus,
  phone_masked: MaskedPhoneNumber.nullable(),
});
export type InstanceStatusData = z.infer<typeof InstanceStatusData>;

/** Data schema of each event type. The outbox and the webhook worker use this map. */
export const EVENT_DATA_SCHEMAS = {
  'message.received': MessageReceivedData,
  'message.status': MessageStatusData,
  'conversation.transitioned': ConversationTransitionedData,
  'instance.status': InstanceStatusData,
} as const satisfies Record<EventType, z.ZodType>;

export type EventDataMap = {
  [K in EventType]: z.infer<(typeof EVENT_DATA_SCHEMAS)[K]>;
};

const envelope = <T extends EventType>(type: T) =>
  z.object({
    id: Uuid,
    type: z.literal(type),
    created_at: IsoDateTime,
    data: EVENT_DATA_SCHEMAS[type],
  });

/**
 * Body of a webhook delivery. `id` is unique for each event and is also the `Webhook-Id` header.
 * A redelivery has the same `id`, so the client can drop duplicates.
 */
export const WebhookEvent = z.discriminatedUnion('type', [
  envelope('message.received'),
  envelope('message.status'),
  envelope('conversation.transitioned'),
  envelope('instance.status'),
]);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export type WebhookEventOf<T extends EventType> = Extract<WebhookEvent, { type: T }>;
