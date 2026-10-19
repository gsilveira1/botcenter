import { z } from 'zod';

/**
 * Zod schemas of the webhook bodies of Evolution API v2.3.7 (Baileys channel).
 * Source: `src/api/integrations/event/webhook/webhook.controller.ts` (envelope) and
 * `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` (the `data` of each event).
 * The schemas accept unknown fields, because Evolution adds fields between versions.
 */

const nullishString = z.string().nullish();

/** The envelope of every webhook call (`webhookData` in the webhook controller). */
export const EvolutionWebhookEnvelope = z.looseObject({
  event: z.string().min(1),
  instance: z.string().min(1),
  data: z.unknown(),
  /** The local time of the Evolution container with a `Z` suffix. It is UTC only when `TZ=UTC`. */
  date_time: nullishString,
  sender: nullishString,
  server_url: nullishString,
  /** The instance token when `AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true`. Never log it. */
  apikey: nullishString,
});
export type EvolutionWebhookEnvelope = z.infer<typeof EvolutionWebhookEnvelope>;

/** Seconds since the epoch. Evolution converts the Baileys `Long` to a number. */
const UnixSeconds = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]);

export const EvolutionMessageKey = z.looseObject({
  id: z.string().min(1),
  remoteJid: z.string().min(1),
  fromMe: z.boolean().nullish(),
  participant: nullishString,
  /** Baileys 7: the phone JID when `remoteJid` is a `@lid` JID. */
  remoteJidAlt: nullishString,
  /** Baileys 6: the old name of `remoteJidAlt`. */
  senderPn: nullishString,
  addressingMode: nullishString,
});

/** `data` of `messages.upsert` (the `messageRaw` of `prepareMessage`). */
export const EvolutionUpsertData = z.looseObject({
  key: EvolutionMessageKey,
  pushName: nullishString,
  message: z.record(z.string(), z.unknown()).nullish(),
  messageType: nullishString,
  messageTimestamp: UnixSeconds.nullish(),
});
export type EvolutionUpsertData = z.infer<typeof EvolutionUpsertData>;

/** `data` of `messages.update`. `status` is one of `ERROR`, `PENDING`, `SERVER_ACK`, `DELIVERY_ACK`, `READ`, `PLAYED`. */
export const EvolutionUpdateData = z.looseObject({
  keyId: z.string().min(1),
  remoteJid: nullishString,
  fromMe: z.boolean().nullish(),
  status: z.string().min(1),
});
export type EvolutionUpdateData = z.infer<typeof EvolutionUpdateData>;

/** `data` of `connection.update`. `state` is `open`, `connecting`, `close`, or `refused`. */
export const EvolutionConnectionData = z.looseObject({
  instance: nullishString,
  state: z.string().min(1),
  statusReason: z.number().nullish(),
  wuid: nullishString,
  profileName: nullishString,
});
export type EvolutionConnectionData = z.infer<typeof EvolutionConnectionData>;

/**
 * `data` of `qrcode.updated`. A normal event has `qrcode`. When the QR code limit is reached,
 * Evolution sends `{ message, statusCode }` without `qrcode`, then `connection.update` with `refused`.
 */
export const EvolutionQrcodeData = z.looseObject({
  qrcode: z
    .looseObject({
      instance: nullishString,
      pairingCode: nullishString,
      code: nullishString,
      base64: nullishString,
    })
    .nullish(),
  message: nullishString,
  statusCode: z.number().nullish(),
});
export type EvolutionQrcodeData = z.infer<typeof EvolutionQrcodeData>;
