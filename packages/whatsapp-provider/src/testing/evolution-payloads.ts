import { randomBytes, randomUUID } from 'node:crypto';
import { phoneToJid } from '../evolution/jid.js';

/**
 * Builders of Evolution API 2.3.7 payloads with the same shape as the recorded fixtures
 * (`fixtures/evolution-2.3.7`). The fake server uses them. A contract test compares the shapes.
 */

export type EvolutionAckStatus =
  'ERROR' | 'PENDING' | 'SERVER_ACK' | 'DELIVERY_ACK' | 'READ' | 'PLAYED';

/** A new WhatsApp message id in the Baileys format (`3EB0` and 18 hex characters). */
export function newMessageId(): string {
  return `3EB0${randomBytes(9).toString('hex').toUpperCase()}`;
}

export function unixSeconds(date = new Date()): number {
  return Math.floor(date.getTime() / 1000);
}

export interface EnvelopeOptions {
  destination: string;
  serverUrl: string;
  /** The JID of the connected number. Evolution omits it before the first connection. */
  sender?: string;
  dateTime?: Date;
}

/** The webhook envelope (`webhookData` of `webhook.controller.ts`). */
export function webhookEnvelope(
  event: string,
  instanceName: string,
  data: unknown,
  options: EnvelopeOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    event,
    instance: instanceName,
    data,
    destination: options.destination,
    date_time: (options.dateTime ?? new Date()).toISOString(),
  };
  if (options.sender) body.sender = options.sender;
  body.server_url = options.serverUrl;
  body.apikey = null;
  return body;
}

/** The body of an Evolution error: `{ status, error, response: { message } }`. */
export function errorBody(status: number, message: unknown): Record<string, unknown> {
  const names: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    500: 'Internal Server Error',
  };
  return { status, error: names[status] ?? 'Error', response: { message } };
}

export function qrcodeData(
  instanceName: string,
  qr: { code: string; base64: string; pairingCode: string | null },
) {
  return {
    qrcode: {
      instance: instanceName,
      pairingCode: qr.pairingCode,
      code: qr.code,
      base64: qr.base64,
    },
  };
}

export function connectionData(
  instanceName: string,
  state: 'open' | 'connecting' | 'close' | 'refused',
  statusReason: number,
  owner?: { phone: string; profileName?: string },
) {
  if (state === 'open' && owner) {
    return {
      instance: instanceName,
      wuid: phoneToJid(owner.phone),
      profileName: owner.profileName ?? 'Fake Owner',
      profilePictureUrl: null,
      state,
      statusReason,
    };
  }
  return { instance: instanceName, state, statusReason };
}

export interface UpsertOptions {
  from: string;
  id?: string;
  pushName?: string;
  timestamp?: Date;
  instanceId: string;
}

/** The `data` of `messages.upsert` (`prepareMessage` output) for a message from a contact. */
export function upsertData(
  message: Record<string, unknown>,
  messageType: string,
  options: UpsertOptions,
) {
  return {
    key: {
      remoteJid: phoneToJid(options.from),
      fromMe: false,
      id: options.id ?? newMessageId(),
      addressingMode: 'pn',
    },
    pushName: options.pushName ?? 'Fake Contact',
    status: 'DELIVERY_ACK',
    message: { ...message, messageContextInfo: { deviceListMetadataVersion: 2 } },
    messageType,
    messageTimestamp: unixSeconds(options.timestamp),
    instanceId: options.instanceId,
    source: 'android',
  };
}

/** The `data` of `messages.update`. */
export function updateData(
  messageId: string,
  to: string | undefined,
  status: EvolutionAckStatus,
  instanceId: string,
) {
  const data: Record<string, unknown> = { keyId: messageId };
  if (to) data.remoteJid = phoneToJid(to);
  data.fromMe = true;
  data.status = status;
  data.instanceId = instanceId;
  return data;
}

/** The response of a send (`messageRaw` of the sent message), status 201. */
export function sentMessageRaw(
  to: string,
  id: string,
  message: Record<string, unknown>,
  messageType: string,
  instanceId: string,
) {
  return {
    key: { remoteJid: phoneToJid(to), fromMe: true, id },
    pushName: 'Você',
    status: 'PENDING',
    message,
    messageType,
    messageTimestamp: unixSeconds(),
    instanceId,
    source: 'web',
  };
}

/** The response of `POST /instance/create` (status 201). */
export function createInstanceResponse(
  body: Record<string, unknown>,
  instanceId: string,
  settings: Record<string, unknown>,
) {
  const webhook = (body.webhook ?? {}) as Record<string, unknown>;
  return {
    instance: {
      instanceName: body.instanceName,
      instanceId,
      integration: body.integration,
      webhookWaBusiness: null,
      accessTokenWaBusiness: '',
      status: 'close',
    },
    hash: randomUUID().toUpperCase(),
    webhook: {
      webhookUrl: webhook.url,
      webhookHeaders: webhook.headers,
      webhookByEvents: webhook.byEvents,
      webhookBase64: webhook.base64,
    },
    websocket: {},
    rabbitmq: {},
    nats: {},
    sqs: {},
    settings,
  };
}

/** A fake QR code reference in the Baileys format and a small PNG data URL. */
export function fakeQrcode(): { code: string; base64: string } {
  const part = () => randomBytes(32).toString('base64');
  return {
    code: `2@${randomBytes(60).toString('base64')},${part()},${part()},${part()}`,
    // A valid 1x1 PNG. The real value is the QR code image.
    base64:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  };
}

/** A pairing code in the WhatsApp format: 8 characters, upper case letters and digits. */
export function fakePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTVWXYZ0123456789';
  return Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
}
