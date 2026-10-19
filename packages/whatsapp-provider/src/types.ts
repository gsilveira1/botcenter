import type { ButtonsContent, ListContent, MediaType, TextContent } from '@botcenter/contracts';

/**
 * Frozen contract between the Bot Center and a WhatsApp provider.
 * Only the provider implementations know the URLs and the payloads of a provider.
 * The rest of the Bot Center uses this interface and the normalized `ProviderEvent` union.
 */

/** The opaque instance name in the provider, always `inst_<uuid>`. Never a phone or a person name. */
export type ProviderInstanceName = string;

/** Phone numbers are E.164 digits without the `+` sign. */
export type PhoneDigits = string;

export type ProviderConnectionState = 'connecting' | 'connected' | 'disconnected' | 'logged_out';

export interface CreateInstanceInput {
  name: ProviderInstanceName;
  /** The internal webhook URL of the Bot Center that the provider calls. */
  webhookUrl: string;
  /** The provider sends this value in the `WEBHOOK_SECRET_HEADER` header of each webhook call. */
  webhookSecret: string;
}

export type ConnectInput = { method: 'qrcode' } | { method: 'pairing_code'; phone: PhoneDigits };

export interface ConnectResult {
  /** The QR code as a base64 PNG data URL, when the provider returns one. */
  qrcodeBase64?: string;
  /** The raw QR code text. */
  qrcode?: string;
  /** The 8-character pairing code, for the `pairing_code` method. */
  pairingCode?: string;
  /** True when the instance is already connected and needs no QR code. */
  alreadyConnected: boolean;
}

/** Media content for the provider: the Bot Center resolves a `media_id` to a short-lived signed URL first. */
export interface OutboundMediaContent {
  type: 'media';
  media_type: MediaType;
  url: string;
  mime_type?: string;
  caption?: string;
  file_name?: string;
}

export type OutboundContent = TextContent | OutboundMediaContent | ButtonsContent | ListContent;

export interface SendMessageInput {
  to: PhoneDigits;
  content: OutboundContent;
  /** The provider shows "typing" for this time before the send (ban mitigation for bot replies). */
  typingDelayMs?: number;
  /** The provider message id that this message answers, when it is a reply. */
  quotedProviderMessageId?: string;
}

export interface SendMessageResult {
  providerMessageId: string;
}

export interface DownloadedMedia {
  data: Buffer;
  mimeType: string;
  fileName?: string;
}

export interface WhatsAppProvider {
  readonly name: string;
  createInstance(input: CreateInstanceInput): Promise<void>;
  connect(name: ProviderInstanceName, input: ConnectInput): Promise<ConnectResult>;
  getConnectionState(name: ProviderInstanceName): Promise<ProviderConnectionState>;
  /** Ends the WhatsApp session. The instance stays in the provider. */
  logout(name: ProviderInstanceName): Promise<void>;
  /** Ends the session and deletes the instance in the provider. A missing instance is not an error. */
  deleteInstance(name: ProviderInstanceName): Promise<void>;
  sendMessage(name: ProviderInstanceName, input: SendMessageInput): Promise<SendMessageResult>;
  downloadMedia(name: ProviderInstanceName, providerMessageId: string): Promise<DownloadedMedia>;
  /** Readiness check. Throws `ProviderError` with code `unavailable` when the provider does not answer. */
  ping(): Promise<void>;
}

/** The header that carries the shared secret on the internal webhook from the provider. */
export const WEBHOOK_SECRET_HEADER = 'x-botcenter-webhook-secret';

export type ProviderErrorCode =
  /** Network error, timeout, or 5xx. The caller can retry. */
  | 'unavailable'
  /** The instance is not connected to WhatsApp. The caller can retry later. */
  | 'not_connected'
  /** The recipient is not a WhatsApp number. Do not retry. */
  | 'invalid_recipient'
  /** The instance does not exist in the provider. Do not retry. */
  | 'not_found'
  /** The provider refused the request (other 4xx). Do not retry. */
  | 'rejected';

const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set(['unavailable', 'not_connected']);

export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly httpStatus?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProviderError';
    this.retryable = RETRYABLE_CODES.has(code);
  }
}

// Normalized events from the provider webhook.

interface ProviderEventBase {
  instanceName: ProviderInstanceName;
  /** A stable key for the 24 h deduplication in Redis. Equal events have equal keys. */
  dedupeKey: string;
  occurredAt: Date;
}

export interface QrcodeUpdatedEvent extends ProviderEventBase {
  kind: 'qrcode.updated';
  qrcodeBase64?: string;
  qrcode?: string;
  pairingCode?: string;
}

export interface ConnectionUpdatedEvent extends ProviderEventBase {
  kind: 'connection.updated';
  state: ProviderConnectionState;
  /** The phone of the connected number, when the provider sends it. */
  phone?: PhoneDigits;
  reason?: string;
}

export type InboundContent =
  | { type: 'text'; text: string }
  | { type: 'button_reply'; buttonId: string; text: string }
  | { type: 'list_reply'; rowId: string; text: string }
  | {
      type: 'media';
      mediaType: MediaType;
      mimeType: string;
      caption?: string;
      fileName?: string;
    }
  | { type: 'unsupported'; providerType: string };

export interface MessageReceivedEvent extends ProviderEventBase {
  kind: 'message.received';
  providerMessageId: string;
  from: PhoneDigits;
  pushName?: string;
  content: InboundContent;
}

export interface MessageStatusEvent extends ProviderEventBase {
  kind: 'message.status';
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
}

export type ProviderEvent =
  QrcodeUpdatedEvent | ConnectionUpdatedEvent | MessageReceivedEvent | MessageStatusEvent;

export type ProviderEventKind = ProviderEvent['kind'];

/**
 * Converts one raw webhook body of a provider into zero or more normalized events.
 * It returns `ignored` for events that the Bot Center does not use (for example, messages from the
 * connected number itself or group messages). It throws `ProviderError` with code `rejected` for a body
 * that does not match the schema of the provider.
 */
export interface ProviderWebhookNormalizer {
  normalize(body: unknown): { events: ProviderEvent[]; ignored: number };
}
