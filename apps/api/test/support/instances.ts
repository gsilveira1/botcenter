import { connectionData, webhookEnvelope } from '@botcenter/whatsapp-provider/testing';
import type { TestHarness } from './harness';

/** Builders of the instances slice: real Evolution v2.3.7 webhook bodies for the connect flow. */

const ENVELOPE = {
  destination: 'http://api.test:3000/internal/evolution/webhook',
  serverUrl: 'http://evolution.test:8080',
};

export const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export interface ConnectionWebhookInput {
  instanceName: string;
  state: 'open' | 'connecting' | 'close' | 'refused';
  /** Default 200. `close` with 401 is `logged_out`; another code is `disconnected`. */
  statusReason?: number;
  /** The phone of the connected number (`open` only). */
  phone?: string;
  /** The `date_time` of the event (its `occurredAt`). Default: now. */
  at?: Date;
}

/** A `connection.update` webhook body. */
export function connectionWebhook(input: ConnectionWebhookInput): Record<string, unknown> {
  const owner = input.phone ? { phone: input.phone } : undefined;
  return webhookEnvelope(
    'connection.update',
    input.instanceName,
    connectionData(input.instanceName, input.state, input.statusReason ?? 200, owner),
    { ...ENVELOPE, ...(input.at ? { dateTime: input.at } : {}) },
  );
}

/** A `qrcode.updated` webhook body with a new QR code (and a pairing code, when given). */
export function qrcodeWebhook(
  instanceName: string,
  options: { code?: string; pairingCode?: string | null } = {},
): Record<string, unknown> {
  // The shape of `fixtures/evolution-2.3.7/webhooks/qrcode-updated` of the provider package.
  const data = {
    qrcode: {
      instance: instanceName,
      pairingCode: options.pairingCode ?? null,
      code: options.code ?? `2@${Math.random().toString(36).slice(2)}`,
      base64: `data:image/png;base64,${PNG_1X1}`,
    },
  };
  return webhookEnvelope('qrcode.updated', instanceName, data, ENVELOPE);
}

/** Creates an instance through the API and returns the JSON body. */
export async function createInstanceViaApi(
  h: TestHarness,
  key: string,
  externalRef: string,
  // The test reads any field of the answer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const response = await h.inject({
    method: 'POST',
    url: '/v1/instances',
    headers: { ...h.bearer(key), 'content-type': 'application/json' },
    payload: JSON.stringify({ external_ref: externalRef, consent_at: new Date().toISOString() }),
  });
  if (response.statusCode !== 201 && response.statusCode !== 200) {
    throw new Error(`create failed: ${response.statusCode} ${response.body}`);
  }
  return response.json();
}
