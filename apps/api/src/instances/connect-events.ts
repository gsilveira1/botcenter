import { ConnectEvent, PairingCode } from '@botcenter/contracts';
import { z } from 'zod';

/**
 * The messages of the connect flow between the processes and the format of the SSE stream.
 * - The worker (and the connect route) publish `ChannelMessage` values on the Redis channel of the
 *   instance (`redisKeys.connectChannel`). Each API process sends them to its open streams.
 * - `revoke` closes the open streams of the older tokens of the instance (one active token).
 */
export const ChannelMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), event: ConnectEvent }),
  z.object({ kind: z.literal('revoke'), keepTokenId: z.string().nullable() }),
]);
export type ChannelMessage = z.infer<typeof ChannelMessage>;

/** The cached code events of an instance (`redisKeys.connectCodes`). */
export const CachedCodes = z.array(ConnectEvent);

/** The QR code and pairing code fields of `ConnectResult` and of the `qrcode.updated` event. */
export interface CodeSource {
  qrcodeBase64?: string | undefined;
  qrcode?: string | undefined;
  pairingCode?: string | undefined;
}

const DATA_URL_PREFIX = /^data:image\/png;base64,/;

/**
 * Converts the codes of the provider to connect events: `qrcode` (PNG base64 without the `data:` prefix
 * and the raw QR text) and `pairing_code`. A value that does not match the contract is left out.
 */
export function codeEvents(source: CodeSource): ConnectEvent[] {
  const events: ConnectEvent[] = [];
  if (source.qrcodeBase64 && source.qrcode) {
    const qrcode = ConnectEvent.safeParse({
      type: 'qrcode',
      png_base64: source.qrcodeBase64.replace(DATA_URL_PREFIX, ''),
      code: source.qrcode,
    });
    if (qrcode.success) {
      events.push(qrcode.data);
    }
  }
  if (source.pairingCode && PairingCode.safeParse(source.pairingCode).success) {
    events.push({ type: 'pairing_code', code: source.pairingCode });
  }
  return events;
}

/** One SSE frame: the `event:` field is the type, the `data:` field is the JSON of the event. */
export function formatSseEvent(event: ConnectEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** An SSE comment. Proxies and browsers ignore it; it keeps the connection open. */
export const SSE_HEARTBEAT = ': heartbeat\n\n';
