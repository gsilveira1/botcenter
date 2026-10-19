import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EvolutionProvider } from '../evolution/evolution-provider.js';
import { EvolutionWebhookNormalizer } from '../evolution/webhook-normalizer.js';
import type { ProviderLogger } from '../logger.js';
import { ProviderError, type ProviderEvent, WEBHOOK_SECRET_HEADER } from '../types.js';
import { FakeEvolutionServer } from './fake-evolution-server.js';

/** A webhook receiver that normalizes each call, like the internal webhook of the API. */
class Receiver {
  readonly events: ProviderEvent[] = [];
  readonly secrets: (string | undefined)[] = [];
  private readonly normalizer = new EvolutionWebhookNormalizer();
  private waiters: { count: number; resolve: () => void }[] = [];
  status = 200;

  constructor(private readonly server: Server) {}

  static async start(): Promise<Receiver> {
    const server = createServer();
    const receiver = new Receiver(server);
    server.on('request', (req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        receiver.secrets.push(req.headers[WEBHOOK_SECRET_HEADER] as string | undefined);
        receiver.events.push(...receiver.normalizer.normalize(JSON.parse(raw)).events);
        receiver.notify();
        res.writeHead(receiver.status);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return receiver;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/internal/evolution/webhook`;
  }

  waitFor(count: number): Promise<void> {
    if (this.events.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  private notify(): void {
    this.waiters = this.waiters.filter((waiter) => {
      if (this.events.length < waiter.count) return true;
      waiter.resolve();
      return false;
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const quiet: ProviderLogger = { debug() {}, info() {}, warn() {}, error() {} };
const NAME = 'inst_0192f1a4-7c2e-7b51-9a0e-3f5d2c8b6e41';
const PHONE = '5511912345678';
const CONTACT = '5511987654321';

let fake: FakeEvolutionServer;
let receiver: Receiver;
let provider: EvolutionProvider;

beforeAll(async () => {
  receiver = await Receiver.start();
});

afterAll(async () => {
  await receiver.close();
});

beforeEach(async () => {
  receiver.events.length = 0;
  receiver.secrets.length = 0;
  receiver.status = 200;
  fake = await FakeEvolutionServer.start({ apiKey: 'k' });
  provider = new EvolutionProvider({
    baseUrl: fake.url,
    apiKey: 'k',
    logger: quiet,
    timeouts: { requestMs: 500, sendMs: 500, connectMs: 500 },
  });
  await provider.createInstance({ name: NAME, webhookUrl: receiver.url, webhookSecret: 'whsec_1' });
});

afterEach(async () => {
  await provider.close();
  await fake.close();
});

async function errorOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('The promise did not reject');
}

describe('FakeEvolutionServer with EvolutionProvider', () => {
  it('runs the connect flow and sends the webhooks with the secret header', async () => {
    await provider.createInstance({
      name: NAME,
      webhookUrl: receiver.url,
      webhookSecret: 'whsec_1',
    });
    expect(await provider.ping()).toBeUndefined();
    expect(await provider.getConnectionState(NAME)).toBe('disconnected');

    const result = await provider.connect(NAME, { method: 'pairing_code', phone: PHONE });
    expect(result.alreadyConnected).toBe(false);
    expect(result.pairingCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(result.qrcodeBase64).toMatch(/^data:image\/png;base64,/);
    await receiver.waitFor(2);
    expect(receiver.events.map((event) => event.kind)).toEqual([
      'connection.updated',
      'qrcode.updated',
    ]);
    expect(receiver.events[1]).toMatchObject({ pairingCode: result.pairingCode });
    expect(receiver.secrets).toEqual(['whsec_1', 'whsec_1']);
    expect(await provider.getConnectionState(NAME)).toBe('connecting');

    await fake.emitConnected(NAME, PHONE);
    expect(receiver.events.at(-1)).toMatchObject({ state: 'connected', phone: PHONE });
    expect(await provider.connect(NAME, { method: 'qrcode' })).toEqual({ alreadyConnected: true });

    expect(fake.callsTo('/instance/create')).toHaveLength(2);
    expect(fake.callsTo('/webhook/set')).toHaveLength(1);
    expect(fake.callsTo('/settings/set')).toHaveLength(1);
  });

  it('sends messages, records them, and maps the send errors', async () => {
    expect(
      (
        await errorOf(
          provider.sendMessage(NAME, { to: CONTACT, content: { type: 'text', text: 'oi' } }),
        )
      ).code,
    ).toBe('not_connected');
    fake.setState(NAME, 'open', PHONE);
    const sent = await provider.sendMessage(NAME, {
      to: CONTACT,
      content: {
        type: 'list',
        text: 'Horários',
        button_text: 'Ver',
        sections: [{ title: 'Seg', rows: [{ id: 'r1', title: '7h' }] }],
      },
    });
    expect(sent.providerMessageId).toMatch(/^3EB0[0-9A-F]{18}$/);
    expect(fake.instance(NAME)?.sent[0]).toMatchObject({
      id: sent.providerMessageId,
      to: CONTACT,
      route: 'sendText',
    });

    fake.addInvalidRecipient('5511900000000');
    expect(
      (
        await errorOf(
          provider.sendMessage(NAME, { to: '5511900000000', content: { type: 'text', text: 'x' } }),
        )
      ).code,
    ).toBe('invalid_recipient');
    expect(
      (
        await errorOf(
          provider.sendMessage('inst_missing', {
            to: CONTACT,
            content: { type: 'text', text: 'x' },
          }),
        )
      ).code,
    ).toBe('not_found');
  });

  it('injects failures: status, timeout, network error, and delay', async () => {
    fake.setState(NAME, 'open', PHONE);
    const send = () =>
      provider.sendMessage(NAME, { to: CONTACT, content: { type: 'text', text: 'x' } });

    fake.failNext({ route: '/message/sendText', status: 503 });
    expect((await errorOf(send())).code).toBe('unavailable');

    fake.failNext({ route: '/message/sendText', hang: true });
    const timeout = await errorOf(send());
    expect(timeout.code).toBe('unavailable');
    expect(timeout.message).toMatch(/timed out/);

    fake.failNext({ route: '/message/sendText', dropConnection: true });
    expect((await errorOf(send())).message).toMatch(/network error/);

    fake.failNext({ route: /sendText/, delayMs: 50 });
    await expect(send()).resolves.toMatchObject({ providerMessageId: expect.any(String) });

    fake.failNext({ times: 2, status: 500 });
    expect((await errorOf(provider.ping())).code).toBe('unavailable');
    expect((await errorOf(provider.ping())).code).toBe('unavailable');
    await expect(provider.ping()).resolves.toBeUndefined();
  });

  it('answers 401 for a wrong API key', async () => {
    const wrong = new EvolutionProvider({ baseUrl: fake.url, apiKey: 'wrong', logger: quiet });
    const error = await errorOf(wrong.ping());
    expect(error).toMatchObject({ code: 'rejected', httpStatus: 401 });
    await wrong.close();
  });

  it('emits inbound messages, replies, media, and status updates that the normalizer accepts', async () => {
    await fake.emitConnected(NAME, PHONE);
    await fake.emitInboundText(NAME, {
      from: CONTACT,
      text: 'Oi',
      id: '3EB0AAAAAAAAAAAAAAAAAA',
      pushName: 'Maria',
    });
    await fake.emitButtonReply(NAME, { from: CONTACT, buttonId: 'plan_monthly', title: 'Mensal' });
    await fake.emitListReply(NAME, { from: CONTACT, rowId: 'slot_1', title: 'Segunda 7h' });
    await fake.emitInboundMedia(NAME, {
      from: CONTACT,
      id: '3EB0BBBBBBBBBBBBBBBBBB',
      mediaType: 'document',
      mimeType: 'application/pdf',
      fileName: 'ficha.pdf',
      data: Buffer.from('%PDF-1.7'),
    });
    await fake.emitStatus(NAME, { messageId: '3EB0CCCCCCCCCCCCCCCCCC', status: 'delivered' });
    await fake.emitLoggedOut(NAME);

    expect(receiver.events.slice(1)).toMatchObject([
      {
        kind: 'message.received',
        from: CONTACT,
        pushName: 'Maria',
        content: { type: 'text', text: 'Oi' },
      },
      {
        kind: 'message.received',
        content: { type: 'button_reply', buttonId: 'plan_monthly', text: 'Mensal' },
      },
      {
        kind: 'message.received',
        content: { type: 'list_reply', rowId: 'slot_1', text: 'Segunda 7h' },
      },
      {
        kind: 'message.received',
        content: {
          type: 'media',
          mediaType: 'document',
          mimeType: 'application/pdf',
          fileName: 'ficha.pdf',
        },
      },
      { kind: 'message.status', providerMessageId: '3EB0CCCCCCCCCCCCCCCCCC', status: 'delivered' },
      { kind: 'connection.updated', state: 'logged_out' },
    ]);

    const media = await provider.downloadMedia(NAME, '3EB0BBBBBBBBBBBBBBBBBB');
    expect(media).toEqual({
      data: Buffer.from('%PDF-1.7'),
      mimeType: 'application/pdf',
      fileName: 'ficha.pdf',
    });
    expect((await errorOf(provider.downloadMedia(NAME, 'missing'))).code).toBe('rejected');
  });

  it('sends the other connection events', async () => {
    await fake.emitQrcode(NAME, { pairingCode: 'ABCD1234' });
    await fake.emitConnecting(NAME);
    await fake.emitDisconnected(NAME);
    await fake.emitRefused(NAME);
    expect(receiver.events).toMatchObject([
      { kind: 'qrcode.updated', pairingCode: 'ABCD1234' },
      { kind: 'connection.updated', state: 'connecting' },
      { kind: 'connection.updated', state: 'disconnected', reason: 'status_428' },
      { kind: 'connection.updated', state: 'logged_out', reason: 'qrcode_limit_reached' },
    ]);
  });

  it('sends automatic status updates after a send when autoStatus is set', async () => {
    const auto = await FakeEvolutionServer.start({ apiKey: 'k', autoStatus: 'read' });
    const autoProvider = new EvolutionProvider({ baseUrl: auto.url, apiKey: 'k', logger: quiet });
    await autoProvider.createInstance({ name: NAME, webhookUrl: receiver.url, webhookSecret: 's' });
    auto.setState(NAME, 'open', PHONE);
    const { providerMessageId } = await autoProvider.sendMessage(NAME, {
      to: CONTACT,
      content: { type: 'text', text: 'x' },
    });
    await auto.flushWebhooks();
    expect(
      receiver.events.map((event) => (event.kind === 'message.status' ? event.status : event.kind)),
    ).toEqual(['sent', 'delivered', 'read']);
    expect(receiver.events[0]).toMatchObject({ providerMessageId });
    await autoProvider.close();
    await auto.close();
  });

  it('logs out with a webhook, and a second logout is a success', async () => {
    await fake.emitConnected(NAME, PHONE);
    await provider.logout(NAME);
    await fake.flushWebhooks();
    expect(receiver.events.at(-1)).toMatchObject({
      kind: 'connection.updated',
      state: 'logged_out',
    });
    await provider.logout(NAME);
    await provider.deleteInstance(NAME);
    await provider.deleteInstance(NAME);
    expect(fake.instance(NAME)).toBeUndefined();
  });

  it('reports a failed automatic webhook', async () => {
    const failures: string[] = [];
    const reporting = await FakeEvolutionServer.start({
      apiKey: 'k',
      onWebhookError: (delivery) =>
        failures.push(`${delivery.event}:${delivery.status ?? delivery.error}`),
    });
    const p = new EvolutionProvider({ baseUrl: reporting.url, apiKey: 'k', logger: quiet });
    await p.createInstance({ name: NAME, webhookUrl: receiver.url, webhookSecret: 's' });
    receiver.status = 500;
    await p.connect(NAME, { method: 'qrcode' });
    await reporting.flushWebhooks();
    expect(failures).toEqual(['connection.update:500', 'qrcode.updated:500']);
    await p.close();
    await reporting.close();
  });

  it('accepts control requests from another process', async () => {
    const control = (body: unknown) =>
      fetch(`${fake.url}/__fake/instances/${NAME}`, {
        method: 'POST',
        headers: { apikey: 'k', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await control({ action: 'connected', phone: PHONE })).status).toBe(202);
    expect((await control({ action: 'inbound_text', from: CONTACT, text: 'Oi' })).status).toBe(202);
    expect((await control({ action: 'nope' })).status).toBe(400);
    await fake.flushWebhooks();
    expect(receiver.events.map((event) => event.kind)).toEqual([
      'connection.updated',
      'message.received',
    ]);
  });

  it('limits the recorded calls', async () => {
    const small = await FakeEvolutionServer.start({ apiKey: 'k', maxRecordedCalls: 2 });
    const p = new EvolutionProvider({ baseUrl: small.url, apiKey: 'k', logger: quiet });
    await p.ping();
    await p.ping();
    await p.ping();
    expect(small.calls).toHaveLength(2);
    small.clearCalls();
    expect(small.calls).toHaveLength(0);
    await p.close();
    await small.close();
  });

  it('answers 404 for an unknown route and 400 for invalid JSON', async () => {
    const unknown = await fetch(`${fake.url}/instance/nope`, { headers: { apikey: 'k' } });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      status: 404,
      error: 'Not Found',
      response: { message: ['Cannot GET /instance/nope'] },
    });
    const invalid = await fetch(`${fake.url}/instance/create`, {
      method: 'POST',
      headers: { apikey: 'k', 'content-type': 'application/json' },
      body: '{',
    });
    expect(invalid.status).toBe(400);
  });
});
