import { z } from 'zod';
import { BotId, IsoDateTime, MaskedPhoneNumber, PhoneNumber, Uuid } from './common.js';
import { CursorQuery, pageOf } from './pagination.js';

/** Lifecycle of an instance (architecture plan, section "Ciclo de vida da instância"). */
export const INSTANCE_STATUSES = [
  'created',
  'connecting',
  'connected',
  'disconnected',
  'logged_out',
] as const;
export const InstanceStatus = z.enum(INSTANCE_STATUSES);
export type InstanceStatus = z.infer<typeof InstanceStatus>;

/** Opaque identifier of the end user in the client product (for example, the trainer id). */
export const ExternalRef = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7E]+$/, 'Must contain only visible ASCII characters, with no spaces');
export type ExternalRef = z.infer<typeof ExternalRef>;

export const RATE_LIMIT_PER_MINUTE_MIN = 1;
export const RATE_LIMIT_PER_MINUTE_MAX = 600;
export const RateLimitPerMinute = z
  .number()
  .int()
  .min(RATE_LIMIT_PER_MINUTE_MIN)
  .max(RATE_LIMIT_PER_MINUTE_MAX);

/**
 * `POST /v1/instances`. If the tenant already has an instance for `external_ref`, the API returns that instance.
 * `consent_at` is the time when the end user accepted the terms and the ban risk notice.
 * Without `rate_limit_per_minute`, the API uses the default of the tenant.
 */
export const CreateInstanceRequest = z.object({
  external_ref: ExternalRef,
  consent_at: IsoDateTime,
  rate_limit_per_minute: RateLimitPerMinute.optional(),
});
export type CreateInstanceRequest = z.infer<typeof CreateInstanceRequest>;

export const InstanceResponse = z.object({
  id: Uuid,
  external_ref: ExternalRef,
  status: InstanceStatus,
  phone_masked: MaskedPhoneNumber.nullable(),
  bot_id: BotId.nullable(),
  rate_limit_per_minute: RateLimitPerMinute,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type InstanceResponse = z.infer<typeof InstanceResponse>;

/** `GET /v1/instances?external_ref=&cursor=&limit=`. */
export const ListInstancesQuery = CursorQuery.extend({
  external_ref: ExternalRef.optional(),
});
export type ListInstancesQuery = z.infer<typeof ListInstancesQuery>;

export const InstancePage = pageOf(InstanceResponse);
export type InstancePage = z.infer<typeof InstancePage>;

export const CONNECT_METHODS = ['qrcode', 'pairing_code'] as const;
export const ConnectMethod = z.enum(CONNECT_METHODS);
export type ConnectMethod = z.infer<typeof ConnectMethod>;

/** `POST /v1/instances/{id}/connect`. The pairing code method needs the phone number of the instance. */
export const ConnectInstanceRequest = z.discriminatedUnion('method', [
  z.object({ method: z.literal('qrcode') }),
  z.object({ method: z.literal('pairing_code'), phone: PhoneNumber }),
]);
export type ConnectInstanceRequest = z.infer<typeof ConnectInstanceRequest>;

/** Lifetime of a connect token, in seconds (10 minutes, one use). */
export const CONNECT_TOKEN_TTL_SECONDS = 600;

/**
 * Response of the connect route. The browser opens `events_url`
 * (`GET /v1/connect/{connect_token}/events`, Server-Sent Events). The API key never goes to the browser.
 */
export const ConnectInstanceResponse = z.object({
  connect_token: z.string().min(32).max(256),
  expires_at: IsoDateTime,
  events_url: z.url(),
});
export type ConnectInstanceResponse = z.infer<typeof ConnectInstanceResponse>;

/**
 * Response of the connect route when the instance is already connected (additive, wave 2). The API makes
 * no connect token and answers 200 with the status.
 */
export const ConnectInstanceConnectedResponse = z.object({
  status: z.literal('connected'),
});
export type ConnectInstanceConnectedResponse = z.infer<typeof ConnectInstanceConnectedResponse>;

/** Pairing code that the user types in WhatsApp ("Linked devices"): 8 characters, no separator. */
export const PairingCode = z.string().regex(/^[A-Z0-9]{8}$/);

/**
 * Events of the connect SSE stream. The SSE `event:` field is the `type`, and the `data:` field is this JSON.
 * - `qrcode`: a new QR code. `png_base64` is a PNG image in base64 (no `data:` prefix). `code` is the raw QR text.
 * - `pairing_code`: the code for the pairing code method.
 * - `status`: a new status of the instance. The stream closes after `connected`.
 * - `expired`: the connect token expired. The stream closes.
 */
export const ConnectEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('qrcode'),
    png_base64: z.base64().min(1),
    code: z.string().min(1),
  }),
  z.object({ type: z.literal('pairing_code'), code: PairingCode }),
  z.object({ type: z.literal('status'), status: InstanceStatus }),
  z.object({ type: z.literal('expired') }),
]);
export type ConnectEvent = z.infer<typeof ConnectEvent>;
export type ConnectEventType = ConnectEvent['type'];
