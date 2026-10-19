import { describe, expect, it } from 'vitest';
import { ProviderError } from '../types.js';
import { FakeWhatsAppProvider } from './fake-whatsapp-provider.js';

const NAME = 'inst_1';
const create = { name: NAME, webhookUrl: 'http://api/hook', webhookSecret: 's1' };
const text = { to: '5511987654321', content: { type: 'text' as const, text: 'oi' } };

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error.code;
    throw error;
  }
  return 'resolved';
}

describe('FakeWhatsAppProvider', () => {
  it('creates idempotently and keeps the last webhook secret', async () => {
    const provider = new FakeWhatsAppProvider();
    await provider.createInstance(create);
    await provider.createInstance({ ...create, webhookSecret: 's2' });
    expect(provider.instances.get(NAME)).toMatchObject({
      state: 'disconnected',
      webhookSecret: 's2',
    });
  });

  it('connects with a QR code or a pairing code, and reports a connected instance', async () => {
    const provider = new FakeWhatsAppProvider();
    await provider.createInstance(create);
    expect(await provider.connect(NAME, { method: 'qrcode' })).toMatchObject({
      alreadyConnected: false,
      qrcode: expect.stringMatching(/^2@/),
    });
    expect(
      (await provider.connect(NAME, { method: 'pairing_code', phone: '5511' })).pairingCode,
    ).toMatch(/^[A-Z0-9]{8}$/);
    expect(await provider.getConnectionState(NAME)).toBe('connecting');
    provider.setState(NAME, 'connected');
    expect(await provider.connect(NAME, { method: 'qrcode' })).toEqual({ alreadyConnected: true });
  });

  it('sends only when connected and records the sends', async () => {
    const provider = new FakeWhatsAppProvider();
    await provider.createInstance(create);
    expect(await codeOf(provider.sendMessage(NAME, text))).toBe('not_connected');
    provider.setState(NAME, 'connected');
    const { providerMessageId } = await provider.sendMessage(NAME, text);
    expect(provider.sentTo(NAME)).toMatchObject([{ providerMessageId, input: text }]);
    provider.addInvalidRecipient('5511900000000');
    expect(await codeOf(provider.sendMessage(NAME, { ...text, to: '5511900000000' }))).toBe(
      'invalid_recipient',
    );
    expect(await codeOf(provider.sendMessage('inst_missing', text))).toBe('not_found');
  });

  it('injects failures for one method or for all methods', async () => {
    const provider = new FakeWhatsAppProvider();
    provider.failNext('ping', 'unavailable');
    expect(await codeOf(provider.ping())).toBe('unavailable');
    await expect(provider.ping()).resolves.toBeUndefined();
    provider.failNext('*', new ProviderError('rejected', 'custom'), 2);
    expect(await codeOf(provider.ping())).toBe('rejected');
    expect(await codeOf(provider.createInstance(create))).toBe('rejected');
    await provider.createInstance(create);
    expect(provider.calls.map((call) => call.method)).toEqual([
      'ping',
      'ping',
      'ping',
      'createInstance',
      'createInstance',
    ]);
  });

  it('logs out, deletes, downloads media, and resets', async () => {
    const provider = new FakeWhatsAppProvider();
    await provider.createInstance(create);
    provider.setState(NAME, 'connected');
    await provider.logout(NAME);
    expect(await provider.getConnectionState(NAME)).toBe('disconnected');
    provider.setMedia(NAME, 'm1', { data: Buffer.from('x'), mimeType: 'image/jpeg' });
    expect(await provider.downloadMedia(NAME, 'm1')).toEqual({
      data: Buffer.from('x'),
      mimeType: 'image/jpeg',
    });
    expect(await codeOf(provider.downloadMedia(NAME, 'm2'))).toBe('rejected');
    await provider.deleteInstance(NAME);
    await provider.deleteInstance(NAME);
    expect(await codeOf(provider.getConnectionState(NAME))).toBe('not_found');
    provider.reset();
    expect(provider.calls).toHaveLength(0);
  });
});
