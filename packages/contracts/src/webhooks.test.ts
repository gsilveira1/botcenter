import { describe, expect, it } from 'vitest';
import {
  CreateWebhookRequest,
  ListWebhookDeliveriesQuery,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_SECONDS,
  WebhookCreatedResponse,
  WebhookDeliveryResponse,
  WebhookResponse,
} from './webhooks.js';

const ID = '01928f3e-8a3b-7c4d-9e5f-0123456789ab';
const NOW = '2026-10-19T12:00:00.000Z';
const SECRET = `whsec_${'A'.repeat(43)}`;

describe('CreateWebhookRequest', () => {
  it('accepts an HTTPS URL and events', () => {
    expect(
      CreateWebhookRequest.safeParse({
        url: 'https://api.example.com/webhooks/botcenter',
        events: ['message.received', 'instance.status'],
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ url: 'http://api.example.com/hook', events: ['message.status'] }],
    [{ url: 'https://api.example.com/hook', events: [] }],
    [{ url: 'https://api.example.com/hook', events: ['message.status', 'message.status'] }],
    [{ url: 'https://api.example.com/hook', events: ['bot.updated'] }],
  ])('refuses %j', (input) => {
    expect(CreateWebhookRequest.safeParse(input).success).toBe(false);
  });
});

describe('webhook responses', () => {
  const webhook = {
    id: ID,
    url: 'https://api.example.com/hook',
    events: ['message.status'],
    created_at: NOW,
  };

  it('shows the secret only in the create response', () => {
    expect(WebhookCreatedResponse.safeParse({ ...webhook, secret: SECRET }).success).toBe(true);
    expect(WebhookCreatedResponse.safeParse(webhook).success).toBe(false);
    expect(WebhookResponse.parse({ ...webhook, secret: SECRET })).not.toHaveProperty('secret');
  });

  it('refuses a secret with a wrong format', () => {
    expect(WebhookCreatedResponse.safeParse({ ...webhook, secret: 'abc' }).success).toBe(false);
  });
});

describe('WebhookDeliveryResponse', () => {
  const delivery = {
    id: ID,
    webhook_id: ID,
    event_id: ID,
    event_type: 'message.received',
    status: 'failed',
    attempts: 2,
    last_status_code: 503,
    next_attempt_at: NOW,
    created_at: NOW,
  };

  it('accepts a failed delivery with a retry', () => {
    expect(WebhookDeliveryResponse.safeParse(delivery).success).toBe(true);
  });

  it('accepts a pending delivery without a status code', () => {
    expect(
      WebhookDeliveryResponse.safeParse({
        ...delivery,
        status: 'pending',
        attempts: 0,
        last_status_code: null,
      }).success,
    ).toBe(true);
  });

  it('refuses an unknown status', () => {
    expect(WebhookDeliveryResponse.safeParse({ ...delivery, status: 'retrying' }).success).toBe(
      false,
    );
  });
});

describe('ListWebhookDeliveriesQuery', () => {
  it('accepts the dead filter', () => {
    expect(ListWebhookDeliveriesQuery.parse({ status: 'dead' })).toEqual({
      status: 'dead',
      limit: 50,
    });
  });

  it('refuses an unknown filter', () => {
    expect(ListWebhookDeliveriesQuery.safeParse({ status: 'x' }).success).toBe(false);
  });
});

describe('retry schedule', () => {
  it('follows the plan: 1 min, 5 min, 30 min, 2 h, 6 h', () => {
    expect(WEBHOOK_RETRY_DELAYS_SECONDS).toEqual([60, 300, 1800, 7200, 21_600]);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(6);
  });
});
