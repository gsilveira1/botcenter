import { describe, expect, it } from 'vitest';
import { EVENT_DATA_SCHEMAS, EVENT_TYPES, WebhookEvent } from './events.js';

const ID = '01928f3e-8a3b-7c4d-9e5f-0123456789ab';
const NOW = '2026-10-19T12:00:00.000Z';
const owner = { instance_id: ID, external_ref: 'trainer-42' };

const samples = {
  'message.received': {
    ...owner,
    message_id: ID,
    from: '5511987654321',
    type: 'media',
    text: 'Foto do treino',
    media: {
      media_id: ID,
      mime_type: 'image/jpeg',
      url: 'https://media.example.com/a.jpg?sig=1',
      expires_at: NOW,
    },
    conversation_id: ID,
  },
  'message.status': { ...owner, message_id: ID, status: 'delivered', failure_reason: null },
  'conversation.transitioned': {
    ...owner,
    conversation_id: ID,
    contact: '5511987654321',
    bot_id: 'onboarding',
    bot_version: 1,
    from_state: 'start',
    to_state: 'ask_name',
    trigger: 'message',
    handoff: false,
  },
  'instance.status': { ...owner, status: 'connected', phone_masked: '5511*****4321' },
} as const;

describe('WebhookEvent', () => {
  it.each(EVENT_TYPES)('accepts a %s event', (type) => {
    const result = WebhookEvent.safeParse({ id: ID, type, created_at: NOW, data: samples[type] });
    expect(result.error?.issues).toBeUndefined();
  });

  it.each(EVENT_TYPES)('requires external_ref in %s', (type) => {
    const { external_ref: _e, ...data } = samples[type];
    expect(EVENT_DATA_SCHEMAS[type].safeParse(data).success).toBe(false);
  });

  it('refuses data of a different type', () => {
    expect(
      WebhookEvent.safeParse({
        id: ID,
        type: 'message.status',
        created_at: NOW,
        data: samples['instance.status'],
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown event type', () => {
    expect(
      WebhookEvent.safeParse({ id: ID, type: 'bot.updated', created_at: NOW, data: {} }).success,
    ).toBe(false);
  });

  it('accepts a minimal text message', () => {
    expect(
      EVENT_DATA_SCHEMAS['message.received'].safeParse({
        ...owner,
        message_id: ID,
        from: '5511987654321',
        type: 'text',
        text: 'Oi',
      }).success,
    ).toBe(true);
  });

  it('refuses an unknown inbound type', () => {
    expect(
      EVENT_DATA_SCHEMAS['message.received'].safeParse({
        ...owner,
        message_id: ID,
        from: '5511987654321',
        type: 'sticker',
      }).success,
    ).toBe(false);
  });
});
