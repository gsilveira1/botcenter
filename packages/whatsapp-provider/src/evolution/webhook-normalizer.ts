import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  type ConnectionUpdatedEvent,
  type MessageReceivedEvent,
  type MessageStatusEvent,
  ProviderError,
  type ProviderEvent,
  type ProviderWebhookNormalizer,
  type QrcodeUpdatedEvent,
} from '../types.js';
import { mapInboundContent } from './inbound-content.js';
import { jidKind, phoneFromJid } from './jid.js';
import {
  EvolutionConnectionData,
  EvolutionQrcodeData,
  EvolutionUpdateData,
  EvolutionUpsertData,
  EvolutionWebhookEnvelope,
} from './webhook-schema.js';

type NormalizeResult = { events: ProviderEvent[]; ignored: number };

const IGNORED: NormalizeResult = { events: [], ignored: 1 };

/** Baileys disconnect codes after which Evolution deletes the session (`codesToNotReconnect`). */
const SESSION_ENDED_REASONS: Record<number, string> = {
  401: 'logged_out',
  402: 'payment_required',
  403: 'forbidden',
  406: 'not_acceptable',
};

/** `messages.update` status values of Evolution (`src/utils/renderStatus.ts`). */
const STATUS_MAP: Record<string, MessageStatusEvent['status'] | undefined> = {
  SERVER_ACK: 'sent',
  DELIVERY_ACK: 'delivered',
  READ: 'read',
  PLAYED: 'read',
  ERROR: 'failed',
};

function parse<T extends z.ZodType>(schema: T, value: unknown, event: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const paths = result.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
    throw new ProviderError(
      'rejected',
      `Evolution webhook "${event}" has an invalid body (${paths})`,
    );
  }
  return result.data;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** Maps `messages.upsert` to `messages.upsert` and `MESSAGES_UPSERT` to the same name. */
function canonicalEvent(event: string): string {
  return event.trim().toLowerCase().replace(/_/g, '.');
}

/**
 * Converts the webhook bodies of Evolution API v2.3.7 to `ProviderEvent` values.
 * It is stateless and has no I/O, so the API can call it in the request path.
 */
export class EvolutionWebhookNormalizer implements ProviderWebhookNormalizer {
  constructor(private readonly now: () => Date = () => new Date()) {}

  normalize(body: unknown): NormalizeResult {
    const envelope = parse(EvolutionWebhookEnvelope, body, 'envelope');
    const event = canonicalEvent(envelope.event);
    switch (event) {
      case 'qrcode.updated':
        return this.qrcode(envelope);
      case 'connection.update':
        return this.connection(envelope);
      case 'messages.upsert':
        return this.upsert(envelope);
      case 'messages.update':
        return this.update(envelope);
      default:
        // `send.message` and all other events: the Bot Center does not use them.
        return IGNORED;
    }
  }

  private occurredAt(envelope: EvolutionWebhookEnvelope, unixSeconds?: number | null): Date {
    if (typeof unixSeconds === 'number' && unixSeconds > 0) return new Date(unixSeconds * 1000);
    if (envelope.date_time) {
      const date = new Date(envelope.date_time);
      if (!Number.isNaN(date.getTime())) return date;
    }
    return this.now();
  }

  private qrcode(envelope: EvolutionWebhookEnvelope): NormalizeResult {
    const data = parse(EvolutionQrcodeData, envelope.data, 'qrcode.updated');
    const qr = data.qrcode;
    // The "QR code limit reached" variant has no QR code. The `connection.update` that follows has `refused`.
    if (!qr || (!qr.code && !qr.pairingCode)) return IGNORED;
    const event: QrcodeUpdatedEvent = {
      kind: 'qrcode.updated',
      instanceName: envelope.instance,
      dedupeKey: `qrcode.updated:${envelope.instance}:${shortHash(`${qr.code ?? ''}|${qr.pairingCode ?? ''}`)}`,
      occurredAt: this.occurredAt(envelope),
    };
    if (qr.base64) event.qrcodeBase64 = qr.base64;
    if (qr.code) event.qrcode = qr.code;
    if (qr.pairingCode) event.pairingCode = qr.pairingCode;
    return { events: [event], ignored: 0 };
  }

  private connection(envelope: EvolutionWebhookEnvelope): NormalizeResult {
    const data = parse(EvolutionConnectionData, envelope.data, 'connection.update');
    const statusReason = data.statusReason ?? undefined;
    let state: ConnectionUpdatedEvent['state'];
    let reason: string | undefined;
    switch (data.state) {
      case 'open':
        state = 'connected';
        break;
      case 'connecting':
        state = 'connecting';
        break;
      case 'close': {
        const ended = statusReason === undefined ? undefined : SESSION_ENDED_REASONS[statusReason];
        state = ended ? 'logged_out' : 'disconnected';
        reason = ended ?? (statusReason === undefined ? undefined : `status_${statusReason}`);
        break;
      }
      case 'refused':
        // The QR code limit was reached before a phone paired. A new connect flow is necessary.
        state = 'logged_out';
        reason = 'qrcode_limit_reached';
        break;
      default:
        return IGNORED;
    }
    const occurredAt = this.occurredAt(envelope);
    const event: ConnectionUpdatedEvent = {
      kind: 'connection.updated',
      instanceName: envelope.instance,
      state,
      dedupeKey: `connection.updated:${envelope.instance}:${data.state}:${statusReason ?? ''}:${envelope.date_time ?? occurredAt.toISOString()}`,
      occurredAt,
    };
    const phone = phoneFromJid(data.wuid);
    if (state === 'connected' && phone) event.phone = phone;
    if (reason) event.reason = reason;
    return { events: [event], ignored: 0 };
  }

  private upsert(envelope: EvolutionWebhookEnvelope): NormalizeResult {
    const items = Array.isArray(envelope.data) ? envelope.data : [envelope.data];
    const result: NormalizeResult = { events: [], ignored: 0 };
    for (const item of items) {
      const event = this.upsertOne(envelope, parse(EvolutionUpsertData, item, 'messages.upsert'));
      if (event) result.events.push(event);
      else result.ignored += 1;
    }
    return result;
  }

  private upsertOne(
    envelope: EvolutionWebhookEnvelope,
    data: EvolutionUpsertData,
  ): MessageReceivedEvent | null {
    const { key } = data;
    if (key.fromMe === true) return null;
    const from = this.senderPhone(key);
    if (!from) return null;
    const content = mapInboundContent(data.message);
    if (!content) return null;
    const event: MessageReceivedEvent = {
      kind: 'message.received',
      instanceName: envelope.instance,
      dedupeKey: `message.received:${envelope.instance}:${key.id}`,
      occurredAt: this.occurredAt(envelope, data.messageTimestamp),
      providerMessageId: key.id,
      from,
      content,
    };
    if (data.pushName) event.pushName = data.pushName;
    return event;
  }

  /**
   * The phone of a direct chat. Evolution puts the phone JID in `remoteJid` when Baileys gives
   * `remoteJidAlt` for a `@lid` chat. Without a phone JID, the message cannot get a reply, so it is ignored.
   */
  private senderPhone(key: EvolutionUpsertData['key']): string | undefined {
    switch (jidKind(key.remoteJid)) {
      case 'phone':
        return phoneFromJid(key.remoteJid);
      case 'lid':
        return phoneFromJid(key.remoteJidAlt) ?? phoneFromJid(key.senderPn);
      default:
        // Groups, status broadcasts, broadcast lists, and newsletters.
        return undefined;
    }
  }

  private update(envelope: EvolutionWebhookEnvelope): NormalizeResult {
    const data = parse(EvolutionUpdateData, envelope.data, 'messages.update');
    // Only the status of messages that the connected number sent is useful.
    if (data.fromMe !== true) return IGNORED;
    if (data.remoteJid && ['group', 'broadcast', 'newsletter'].includes(jidKind(data.remoteJid))) {
      return IGNORED;
    }
    const status = STATUS_MAP[data.status];
    if (!status) return IGNORED;
    const event: MessageStatusEvent = {
      kind: 'message.status',
      instanceName: envelope.instance,
      dedupeKey: `message.status:${envelope.instance}:${data.keyId}:${status}`,
      occurredAt: this.occurredAt(envelope),
      providerMessageId: data.keyId,
      status,
    };
    return { events: [event], ignored: 0 };
  }
}
