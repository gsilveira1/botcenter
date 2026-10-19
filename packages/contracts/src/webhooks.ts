import { z } from 'zod';
import { HttpsUrl, IsoDateTime, Uuid } from './common.js';
import { EventType } from './events.js';
import { CursorQuery, pageOf } from './pagination.js';

/** Prefix of a webhook secret. The full secret (prefix included, UTF-8) is the HMAC key. */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';
/** `whsec_` and 32 random bytes in base64url (43 characters). */
export const WebhookSecret = z.string().regex(/^whsec_[A-Za-z0-9_-]{43}$/);
export type WebhookSecret = z.infer<typeof WebhookSecret>;

/**
 * Delay before each retry of a failed delivery, in seconds: 1 min, 5 min, 30 min, 2 h, 6 h.
 * After the last retry fails, the delivery is `dead`. `POST /v1/webhooks/deliveries/{id}/redeliver` sends it again.
 */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 21_600] as const;
/** The first attempt plus one attempt for each retry delay. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_SECONDS.length + 1;
/** Time limit of one delivery request, in milliseconds. */
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;

/** `POST /v1/webhooks`. */
export const CreateWebhookRequest = z
  .object({
    url: HttpsUrl,
    events: z.array(EventType).min(1),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.events).size !== value.events.length) {
      ctx.addIssue({ code: 'custom', path: ['events'], message: 'An event type must not repeat' });
    }
  });
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequest>;

export const WebhookResponse = z.object({
  id: Uuid,
  url: HttpsUrl,
  events: z.array(EventType),
  created_at: IsoDateTime,
});
export type WebhookResponse = z.infer<typeof WebhookResponse>;

/** Response of `POST /v1/webhooks` (201). The API shows the secret only in this response. */
export const WebhookCreatedResponse = WebhookResponse.extend({
  secret: WebhookSecret,
});
export type WebhookCreatedResponse = z.infer<typeof WebhookCreatedResponse>;

export const WebhookPage = pageOf(WebhookResponse);
export type WebhookPage = z.infer<typeof WebhookPage>;

/**
 * Status of a delivery:
 * `pending` (not sent yet), `succeeded` (2xx), `failed` (the last attempt failed and a retry is scheduled),
 * `dead` (no retry left).
 */
export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'succeeded', 'failed', 'dead'] as const;
export const WebhookDeliveryStatus = z.enum(WEBHOOK_DELIVERY_STATUSES);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatus>;

export const WebhookDeliveryResponse = z.object({
  id: Uuid,
  webhook_id: Uuid,
  event_id: Uuid,
  event_type: EventType,
  status: WebhookDeliveryStatus,
  attempts: z.number().int().min(0),
  last_status_code: z.number().int().min(100).max(599).nullable(),
  next_attempt_at: IsoDateTime.nullable(),
  created_at: IsoDateTime,
});
export type WebhookDeliveryResponse = z.infer<typeof WebhookDeliveryResponse>;

/** `GET /v1/webhooks/deliveries?status=&cursor=&limit=`. */
export const ListWebhookDeliveriesQuery = CursorQuery.extend({
  status: WebhookDeliveryStatus.optional(),
});
export type ListWebhookDeliveriesQuery = z.infer<typeof ListWebhookDeliveriesQuery>;

export const WebhookDeliveryPage = pageOf(WebhookDeliveryResponse);
export type WebhookDeliveryPage = z.infer<typeof WebhookDeliveryPage>;
