import { describe, expect, it } from 'vitest';
import { webhookFixture } from '../test-support/fixtures.js';
import { ProviderError } from '../types.js';
import { EvolutionWebhookNormalizer } from './webhook-normalizer.js';

const INSTANCE = 'inst_0192f1a4-7c2e-7b51-9a0e-3f5d2c8b6e41';
const FIXED_NOW = new Date('2030-01-01T00:00:00.000Z');
const normalizer = new EvolutionWebhookNormalizer(() => FIXED_NOW);

function one(name: string) {
  const result = normalizer.normalize(webhookFixture(name));
  expect(result.ignored).toBe(0);
  expect(result.events).toHaveLength(1);
  return result.events[0]!;
}

function ignored(name: string) {
  expect(normalizer.normalize(webhookFixture(name))).toEqual({ events: [], ignored: 1 });
}

describe('EvolutionWebhookNormalizer: qrcode.updated', () => {
  it('maps the recorded QR code event', () => {
    const fixture = webhookFixture('qrcode-updated');
    const event = one('qrcode-updated');
    expect(event).toMatchObject({
      kind: 'qrcode.updated',
      instanceName: INSTANCE,
      occurredAt: new Date('2026-10-19T12:48:44.319Z'),
    });
    if (event.kind !== 'qrcode.updated') throw new Error('unexpected kind');
    const qrcode = (fixture.data as { qrcode: { code: string; base64: string } }).qrcode;
    expect(event.qrcode).toBe(qrcode.code);
    expect(event.qrcodeBase64).toBe(qrcode.base64);
    expect(event.qrcodeBase64).toMatch(/^data:image\/png;base64,/);
    expect(event.pairingCode).toBeUndefined();
    expect(event.dedupeKey).toMatch(/^qrcode\.updated:inst_[\w-]+:[0-9a-f]{32}$/);
  });

  it('maps the recorded pairing code event', () => {
    const event = one('qrcode-updated.pairing-code');
    expect(event).toMatchObject({ kind: 'qrcode.updated', pairingCode: 'W7NWNLQ6' });
  });

  it('gives equal events equal dedupe keys and different QR codes different keys', () => {
    const a = one('qrcode-updated');
    const b = one('qrcode-updated');
    const c = one('qrcode-updated.pairing-code');
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.dedupeKey).not.toBe(c.dedupeKey);
  });

  it('ignores the "QR code limit reached" variant (the refused connection event follows)', () => {
    ignored('qrcode-updated.limit-reached');
  });
});

describe('EvolutionWebhookNormalizer: connection.update', () => {
  it('maps the recorded "connecting" event', () => {
    expect(one('connection-update.connecting')).toEqual({
      kind: 'connection.updated',
      instanceName: INSTANCE,
      state: 'connecting',
      occurredAt: new Date('2026-10-19T12:48:43.457Z'),
      dedupeKey: `connection.updated:${INSTANCE}:connecting:200:2026-10-19T12:48:43.457Z`,
    });
  });

  it('maps "open" to connected with the phone of the connected number', () => {
    expect(one('connection-update.open')).toMatchObject({
      kind: 'connection.updated',
      state: 'connected',
      phone: '5511912345678',
    });
  });

  it('maps the recorded "close" with status 401 to logged_out', () => {
    expect(one('connection-update.close-401')).toMatchObject({
      state: 'logged_out',
      reason: 'logged_out',
    });
  });

  it('maps "close" with status 403 to logged_out with the reason "forbidden"', () => {
    expect(one('connection-update.close-403')).toMatchObject({
      state: 'logged_out',
      reason: 'forbidden',
    });
  });

  it('maps "close" with a code that Evolution reconnects to disconnected', () => {
    const body = webhookFixture('connection-update.close-401');
    (body.data as { statusReason: number }).statusReason = 428;
    expect(normalizer.normalize(body).events[0]).toMatchObject({
      state: 'disconnected',
      reason: 'status_428',
    });
  });

  it('maps "refused" (QR code limit) to logged_out', () => {
    expect(one('connection-update.refused')).toMatchObject({
      state: 'logged_out',
      reason: 'qrcode_limit_reached',
    });
  });

  it('ignores an unknown state', () => {
    const body = webhookFixture('connection-update.connecting');
    (body.data as { state: string }).state = 'paused';
    expect(normalizer.normalize(body)).toEqual({ events: [], ignored: 1 });
  });
});

describe('EvolutionWebhookNormalizer: messages.upsert', () => {
  it('maps a text message with the message timestamp', () => {
    expect(one('messages-upsert.text')).toEqual({
      kind: 'message.received',
      instanceName: INSTANCE,
      providerMessageId: '3EB0C431C26A1916E2E9A4',
      from: '5511987654321',
      pushName: 'Maria Silva',
      content: { type: 'text', text: 'Oi, quero agendar uma aula' },
      occurredAt: new Date(1792404000 * 1000),
      dedupeKey: `message.received:${INSTANCE}:3EB0C431C26A1916E2E9A4`,
    });
  });

  it('maps a quoted reply as text', () => {
    expect(one('messages-upsert.quoted-reply')).toMatchObject({
      content: { type: 'text', text: 'Sim, pode ser' },
    });
  });

  it('unwraps an ephemeral extended text message', () => {
    expect(one('messages-upsert.ephemeral-extended-text')).toMatchObject({
      content: { type: 'text', text: 'Quero o plano mensal' },
    });
  });

  it('uses the phone JID for a @lid chat when Evolution gives it', () => {
    expect(one('messages-upsert.lid-with-phone')).toMatchObject({ from: '5511987654321' });
  });

  it('ignores a @lid chat without a phone JID (no reply is possible)', () => {
    ignored('messages-upsert.lid-without-phone');
  });

  it('uses remoteJidAlt when remoteJid is still a @lid JID', () => {
    const body = webhookFixture('messages-upsert.lid-without-phone');
    (body.data as { key: Record<string, unknown> }).key.remoteJidAlt =
      '5521988887777@s.whatsapp.net';
    expect(normalizer.normalize(body).events[0]).toMatchObject({ from: '5521988887777' });
  });

  it.each([
    [
      'messages-upsert.image',
      { type: 'media', mediaType: 'image', mimeType: 'image/jpeg', caption: 'Meu treino de hoje' },
    ],
    ['messages-upsert.audio-ptt', { type: 'media', mediaType: 'audio', mimeType: 'audio/ogg' }],
    ['messages-upsert.video', { type: 'media', mediaType: 'video', mimeType: 'video/mp4' }],
    [
      'messages-upsert.document',
      {
        type: 'media',
        mediaType: 'document',
        mimeType: 'application/pdf',
        fileName: 'anamnese.pdf',
        caption: 'Segue a ficha',
      },
    ],
    ['messages-upsert.sticker', { type: 'media', mediaType: 'image', mimeType: 'image/webp' }],
  ])('maps %s as media', (fixture, content) => {
    expect(one(fixture).kind).toBe('message.received');
    expect(one(fixture)).toMatchObject({ content });
  });

  it.each([
    [
      'messages-upsert.buttons-response',
      { type: 'button_reply', buttonId: 'plan_monthly', text: 'Mensal' },
    ],
    [
      'messages-upsert.template-button-reply',
      { type: 'button_reply', buttonId: 'confirm_yes', text: 'Sim' },
    ],
    [
      'messages-upsert.interactive-response',
      { type: 'button_reply', buttonId: 'plan_monthly', text: 'Mensal' },
    ],
    [
      'messages-upsert.list-response',
      { type: 'list_reply', rowId: 'slot_mon_7', text: 'Segunda 7h' },
    ],
  ])('maps %s as a reply', (fixture, content) => {
    expect(one(fixture)).toMatchObject({ content });
  });

  it('maps an unknown message type as unsupported', () => {
    expect(one('messages-upsert.location')).toMatchObject({
      content: { type: 'unsupported', providerType: 'locationMessage' },
    });
  });

  it.each([
    'messages-upsert.reaction',
    'messages-upsert.from-me',
    'messages-upsert.group',
    'messages-upsert.status-broadcast',
  ])('ignores %s', (fixture) => {
    ignored(fixture);
  });

  it('ignores a protocol message', () => {
    const body = webhookFixture('messages-upsert.text');
    (body.data as { message: Record<string, unknown> }).message = {
      protocolMessage: { type: 0, key: { id: 'X' } },
    };
    expect(normalizer.normalize(body)).toEqual({ events: [], ignored: 1 });
  });

  it('maps an interactive response without an id as unsupported', () => {
    const body = webhookFixture('messages-upsert.interactive-response');
    const message = (body.data as { message: Record<string, Record<string, unknown>> }).message;
    message.interactiveResponseMessage!.nativeFlowResponseMessage = { paramsJson: 'not json' };
    expect(normalizer.normalize(body).events[0]).toMatchObject({
      content: { type: 'unsupported', providerType: 'interactiveResponseMessage' },
    });
  });

  it('accepts an array of messages in data', () => {
    const body = webhookFixture('messages-upsert.text');
    body.data = [body.data, webhookFixture('messages-upsert.group').data];
    const result = normalizer.normalize(body);
    expect(result.events).toHaveLength(1);
    expect(result.ignored).toBe(1);
  });

  it('uses date_time when the message has no timestamp, and the clock when there is none', () => {
    const body = webhookFixture('messages-upsert.text');
    delete (body.data as Record<string, unknown>).messageTimestamp;
    expect(normalizer.normalize(body).events[0]?.occurredAt).toEqual(
      new Date('2026-10-19T10:00:01.234Z'),
    );
    delete body.date_time;
    expect(normalizer.normalize(body).events[0]?.occurredAt).toEqual(FIXED_NOW);
  });

  it('accepts a timestamp as a numeric string', () => {
    const body = webhookFixture('messages-upsert.text');
    (body.data as Record<string, unknown>).messageTimestamp = '1792404000';
    expect(normalizer.normalize(body).events[0]?.occurredAt).toEqual(new Date(1792404000 * 1000));
  });
});

describe('EvolutionWebhookNormalizer: messages.update', () => {
  it.each([
    ['messages-update.server-ack', 'sent'],
    ['messages-update.delivery-ack', 'delivered'],
    ['messages-update.read', 'read'],
    ['messages-update.played', 'read'],
    ['messages-update.error', 'failed'],
  ])('maps %s to %s', (fixture, status) => {
    expect(one(fixture)).toEqual({
      kind: 'message.status',
      instanceName: INSTANCE,
      providerMessageId: '3EB0FEDCBA9876543210AB',
      status,
      occurredAt: new Date('2026-10-19T10:00:01.234Z'),
      dedupeKey: `message.status:${INSTANCE}:3EB0FEDCBA9876543210AB:${status}`,
    });
  });

  it.each(['messages-update.pending', 'messages-update.inbound-read'])('ignores %s', (fixture) => {
    ignored(fixture);
  });
});

describe('EvolutionWebhookNormalizer: other events and invalid bodies', () => {
  it('ignores send.message (the send response gives the id)', () => {
    ignored('send-message');
  });

  it('accepts the upper case event names of the global events', () => {
    const body = webhookFixture('messages-upsert.text');
    body.event = 'MESSAGES_UPSERT';
    expect(normalizer.normalize(body).events).toHaveLength(1);
  });

  it('ignores an unknown event', () => {
    expect(normalizer.normalize({ event: 'chats.upsert', instance: INSTANCE, data: [] })).toEqual({
      events: [],
      ignored: 1,
    });
  });

  it.each([null, 'text', {}, { event: 'messages.upsert' }, { instance: INSTANCE, data: {} }])(
    'rejects the invalid envelope %j',
    (body) => {
      expect(() => normalizer.normalize(body)).toThrow(ProviderError);
    },
  );

  it('rejects a messages.upsert without a key, with code "rejected" and no content in the message', () => {
    const body = webhookFixture('messages-upsert.text');
    delete (body.data as Record<string, unknown>).key;
    try {
      normalizer.normalize(body);
      expect.unreachable('normalize must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe('rejected');
      expect((error as ProviderError).retryable).toBe(false);
      expect((error as ProviderError).message).not.toContain('Oi, quero');
    }
  });

  it('never puts the apikey field into an event', () => {
    const body = webhookFixture('messages-upsert.text');
    body.apikey = 'SECRET-INSTANCE-TOKEN';
    expect(JSON.stringify(normalizer.normalize(body))).not.toContain('SECRET-INSTANCE-TOKEN');
  });
});
