import {
  CreateWebhookRequest,
  CursorQuery,
  ListWebhookDeliveriesQuery,
  UuidParam,
  WebhookCreatedResponse,
  WebhookDeliveryPage,
  WebhookDeliveryResponse,
  WebhookPage,
} from '@botcenter/contracts';
import type { EventType, WebhookDeliveryStatus, WebhookResponse } from '@botcenter/contracts';
import { createZodDto } from '../common/zod-dto';
import type { WebhookDelivery, WebhookSubscription } from '../generated/prisma/client';

export class CreateWebhookBody extends createZodDto(CreateWebhookRequest) {}
export class ListWebhooksQuery extends createZodDto(CursorQuery) {}
export class ListWebhookDeliveriesQueryDto extends createZodDto(ListWebhookDeliveriesQuery) {}
export class WebhookParams extends createZodDto(UuidParam) {}
export class WebhookCreatedResponseDto extends createZodDto(WebhookCreatedResponse) {}
export class WebhookPageDto extends createZodDto(WebhookPage) {}
export class WebhookDeliveryResponseDto extends createZodDto(WebhookDeliveryResponse) {}
export class WebhookDeliveryPageDto extends createZodDto(WebhookDeliveryPage) {}

export function toWebhookResponse(
  row: Pick<WebhookSubscription, 'id' | 'url' | 'events' | 'createdAt'>,
): WebhookResponse {
  return {
    id: row.id,
    url: row.url,
    // The API wrote the values from the contracts enum.
    events: row.events as EventType[],
    created_at: row.createdAt.toISOString(),
  };
}

export function toDeliveryResponse(row: WebhookDelivery): WebhookDeliveryResponse {
  return {
    id: row.id,
    webhook_id: row.subscriptionId,
    event_id: row.eventId,
    event_type: row.eventType as EventType,
    status: row.status satisfies WebhookDeliveryStatus,
    attempts: row.attempts,
    last_status_code: row.lastStatusCode,
    next_attempt_at: row.nextAttemptAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}
