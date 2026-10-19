import { describe, expect, it, vi } from 'vitest';
import type { ProviderLogger } from '../logger.js';
import { apiFixture, type ApiFixture } from '../test-support/fixtures.js';
import { ProviderError, WEBHOOK_SECRET_HEADER } from '../types.js';
import { EvolutionProvider, mapEvolutionState } from './evolution-provider.js';
import type { FetchLike, HttpRequestInit } from './http.js';

/**
 * Contract tests of the adapter: each Evolution answer is a recorded (or source) fixture.
 * The fake fetch answers by "METHOD path" and records the requests.
 */

const NAME = 'inst_0192f1a4-7c2e-7b51-9a0e-3f5d2c8b6e41';
const API_KEY = 'test-key-123';

interface Sent {
  url: string;
  init: HttpRequestInit;
  body: unknown;
}

function silentLogger(): ProviderLogger & { lines: string[] } {
  const lines: string[] = [];
  const write = (fields: Record<string, unknown>, message: string) => {
    lines.push(`${message} ${JSON.stringify(fields)}`);
  };
  return { lines, debug: write, info: write, warn: write, error: write };
}

function setup(routes: Record<string, ApiFixture | ApiFixture[] | Error>) {
  const sent: Sent[] = [];
  const queues = new Map(
    Object.entries(routes).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : [value],
    ]),
  );
  const fetch: FetchLike = async (url, init) => {
    const path = url.replace('http://evolution:8080', '');
    sent.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const key = `${init.method} ${path.split('?')[0]}`;
    const queue = queues.get(key);
    const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (next === undefined) throw new Error(`No fake answer for ${key}`);
    if (next instanceof Error) throw next;
    return { status: next.status, text: async () => JSON.stringify(next.body) };
  };
  const logger = silentLogger();
  const provider = new EvolutionProvider({
    baseUrl: 'http://evolution:8080/',
    apiKey: API_KEY,
    fetch,
    logger,
    deleteRetry: { attempts: 3, delayMs: 0 },
  });
  return { provider, sent, logger };
}

async function providerError(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error('The promise did not reject');
}

const STATE_CLOSE = apiFixture('connection-state.200-close');
const STATE_CONNECTING = apiFixture('connection-state.200-connecting');
const STATE_OPEN = apiFixture('connection-state.200-open');

describe('EvolutionProvider: options', () => {
  it('requires the base URL and the API key', () => {
    expect(() => new EvolutionProvider({ baseUrl: '', apiKey: 'x' })).toThrow(TypeError);
    expect(() => new EvolutionProvider({ baseUrl: 'http://x', apiKey: '' })).toThrow(TypeError);
  });

  it('sends the global API key in the apikey header and JSON bodies', async () => {
    const { provider, sent } = setup({
      'POST /instance/create': apiFixture('create-instance.201'),
    });
    await provider.createInstance({
      name: NAME,
      webhookUrl: 'http://api/hook',
      webhookSecret: 's',
    });
    expect(sent[0]?.url).toBe('http://evolution:8080/instance/create');
    expect(sent[0]?.init.headers).toMatchObject({
      apikey: API_KEY,
      'content-type': 'application/json',
    });
  });
});

describe('EvolutionProvider.createInstance', () => {
  const input = {
    name: NAME,
    webhookUrl: 'http://api:3000/internal/evolution/webhook',
    webhookSecret: 'whsec_x',
  };

  it('creates a Baileys instance without a QR code, with the webhook and the settings', async () => {
    const { provider, sent } = setup({
      'POST /instance/create': apiFixture('create-instance.201'),
    });
    await provider.createInstance(input);
    expect(sent[0]?.body).toEqual({
      instanceName: NAME,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: false,
      rejectCall: false,
      msgCall: '',
      groupsIgnore: true,
      alwaysOnline: false,
      readMessages: false,
      readStatus: false,
      syncFullHistory: false,
      webhook: {
        enabled: true,
        url: input.webhookUrl,
        byEvents: false,
        base64: false,
        headers: { [WEBHOOK_SECRET_HEADER]: 'whsec_x' },
        events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'MESSAGES_UPDATE'],
      },
    });
  });

  it('can reject calls when the option is on', async () => {
    const { sent } = setup({ 'POST /instance/create': apiFixture('create-instance.201') });
    const provider = new EvolutionProvider({
      baseUrl: 'http://evolution:8080',
      apiKey: API_KEY,
      rejectCalls: true,
      fetch: async (url, init) => {
        sent.push({ url, init, body: JSON.parse(init.body!) });
        return { status: 201, text: async () => '{}' };
      },
    });
    await provider.createInstance(input);
    expect(sent[0]?.body).toMatchObject({ rejectCall: true });
  });

  it('is idempotent: on 403 "already in use" it writes the webhook and the settings again', async () => {
    const { provider, sent } = setup({
      'POST /instance/create': apiFixture('create-instance.403-already-in-use'),
      [`POST /webhook/set/${NAME}`]: apiFixture('webhook-set.201'),
      [`POST /settings/set/${NAME}`]: apiFixture('settings-set.201'),
    });
    await provider.createInstance(input);
    expect(sent.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      'POST http://evolution:8080/instance/create',
      `POST http://evolution:8080/webhook/set/${NAME}`,
      `POST http://evolution:8080/settings/set/${NAME}`,
    ]);
    expect(sent[1]?.body).toMatchObject({
      webhook: {
        enabled: true,
        url: input.webhookUrl,
        headers: { [WEBHOOK_SECRET_HEADER]: 'whsec_x' },
      },
    });
    expect(sent[2]?.body).toMatchObject({ groupsIgnore: true, rejectCall: false });
  });

  it('fails when the webhook update of an existing instance fails', async () => {
    const { provider } = setup({
      'POST /instance/create': apiFixture('create-instance.403-already-in-use'),
      [`POST /webhook/set/${NAME}`]: { status: 500, body: { status: 500 } },
    });
    expect((await providerError(provider.createInstance(input))).code).toBe('unavailable');
  });

  it('maps a 401 (wrong API key) to rejected', async () => {
    const { provider } = setup({
      'POST /instance/create': apiFixture('fetch-instances.401-wrong-api-key'),
    });
    const error = await providerError(provider.createInstance(input));
    expect(error.code).toBe('rejected');
    expect(error.httpStatus).toBe(401);
    expect(error.retryable).toBe(false);
  });
});

describe('EvolutionProvider.connect', () => {
  it('returns the recorded QR code', async () => {
    const fixture = apiFixture('connect.200-qrcode');
    const { provider, sent } = setup({ [`GET /instance/connect/${NAME}`]: fixture });
    const result = await provider.connect(NAME, { method: 'qrcode' });
    const body = fixture.body as { code: string; base64: string };
    expect(result).toEqual({
      alreadyConnected: false,
      qrcode: body.code,
      qrcodeBase64: body.base64,
    });
    expect(sent[0]?.url).toBe(`http://evolution:8080/instance/connect/${NAME}`);
  });

  it('asks for a pairing code with the number query parameter', async () => {
    const { provider, sent } = setup({
      [`GET /instance/connect/${NAME}`]: apiFixture('connect.200-pairing-code'),
    });
    const result = await provider.connect(NAME, { method: 'pairing_code', phone: '5511987654321' });
    expect(result.pairingCode).toBe('W7NWNLQ6');
    expect(result.alreadyConnected).toBe(false);
    expect(sent[0]?.url).toBe(
      `http://evolution:8080/instance/connect/${NAME}?number=5511987654321`,
    );
  });

  it('detects the already connected state', async () => {
    const { provider } = setup({
      [`GET /instance/connect/${NAME}`]: apiFixture('connect.200-open'),
    });
    expect(await provider.connect(NAME, { method: 'qrcode' })).toEqual({ alreadyConnected: true });
  });

  it('accepts an answer without a QR code yet (the webhook brings it later)', async () => {
    const { provider } = setup({
      [`GET /instance/connect/${NAME}`]: { status: 200, body: { count: 0 } },
    });
    expect(await provider.connect(NAME, { method: 'qrcode' })).toEqual({ alreadyConnected: false });
  });

  it('reads the QR code of the "other state" answer shape', async () => {
    const { provider } = setup({
      [`GET /instance/connect/${NAME}`]: {
        status: 200,
        body: {
          instance: { instanceName: NAME, status: 'refused' },
          qrcode: { code: 'abc', base64: 'data:x' },
        },
      },
    });
    expect(await provider.connect(NAME, { method: 'qrcode' })).toEqual({
      alreadyConnected: false,
      qrcode: 'abc',
      qrcodeBase64: 'data:x',
    });
  });

  it('maps the 200 `{ error: true }` answer to unavailable', async () => {
    const { provider } = setup({
      [`GET /instance/connect/${NAME}`]: {
        status: 200,
        body: { error: true, message: 'Error: x' },
      },
    });
    expect((await providerError(provider.connect(NAME, { method: 'qrcode' }))).code).toBe(
      'unavailable',
    );
  });

  it('maps a missing instance to not_found', async () => {
    const { provider } = setup({
      [`GET /instance/connect/${NAME}`]: apiFixture('connection-state.404-missing'),
    });
    const error = await providerError(provider.connect(NAME, { method: 'qrcode' }));
    expect(error.code).toBe('not_found');
    expect(error.retryable).toBe(false);
  });
});

describe('EvolutionProvider.getConnectionState', () => {
  it.each([
    [STATE_CLOSE, 'disconnected'],
    [STATE_CONNECTING, 'connecting'],
    [STATE_OPEN, 'connected'],
  ] as const)('maps the state', async (fixture, expected) => {
    const { provider } = setup({ [`GET /instance/connectionState/${NAME}`]: fixture });
    expect(await provider.getConnectionState(NAME)).toBe(expected);
  });

  it('maps the raw states', () => {
    expect(mapEvolutionState('refused')).toBe('logged_out');
    expect(mapEvolutionState(undefined)).toBe('disconnected');
  });

  it('maps a missing instance to not_found', async () => {
    const { provider } = setup({
      [`GET /instance/connectionState/${NAME}`]: apiFixture('connection-state.404-missing'),
    });
    expect((await providerError(provider.getConnectionState(NAME))).code).toBe('not_found');
  });
});

describe('EvolutionProvider.logout and deleteInstance', () => {
  it('logs out', async () => {
    const { provider, sent } = setup({
      [`DELETE /instance/logout/${NAME}`]: apiFixture('logout.200'),
    });
    await provider.logout(NAME);
    expect(sent[0]?.init.method).toBe('DELETE');
  });

  it('treats the recorded 400 "is not connected" as success', async () => {
    const { provider } = setup({
      [`DELETE /instance/logout/${NAME}`]: apiFixture('logout.400-not-connected'),
    });
    await expect(provider.logout(NAME)).resolves.toBeUndefined();
  });

  it('maps a logout of a missing instance to not_found', async () => {
    const { provider } = setup({
      [`DELETE /instance/logout/${NAME}`]: apiFixture('connection-state.404-missing'),
    });
    expect((await providerError(provider.logout(NAME))).code).toBe('not_found');
  });

  it('deletes, and a missing instance is not an error', async () => {
    const { provider } = setup({
      [`DELETE /instance/delete/${NAME}`]: [
        apiFixture('delete.200'),
        apiFixture('connection-state.404-missing'),
      ],
    });
    await provider.deleteInstance(NAME);
    await expect(provider.deleteInstance(NAME)).resolves.toBeUndefined();
  });

  // Evolution 2.3.7 answers 400 when its internal logout fails while the session changes state
  // (`deleteInstance` wraps every error in a BadRequestException). A later call succeeds.
  const transientDelete400 = {
    status: 400,
    body: {
      status: 400,
      error: 'Bad Request',
      response: { message: ['Error: Connection Closed'] },
    },
  };

  it('retries a delete after a transient 400 and succeeds', async () => {
    const { provider, sent } = setup({
      [`DELETE /instance/delete/${NAME}`]: [transientDelete400, apiFixture('delete.200')],
    });
    await expect(provider.deleteInstance(NAME)).resolves.toBeUndefined();
    expect(sent.filter((call) => call.url.includes('/instance/delete/'))).toHaveLength(2);
  });

  it('maps a delete that answers 400 at every attempt to rejected', async () => {
    const { provider, sent } = setup({ [`DELETE /instance/delete/${NAME}`]: transientDelete400 });
    expect((await providerError(provider.deleteInstance(NAME))).code).toBe('rejected');
    expect(sent.filter((call) => call.url.includes('/instance/delete/'))).toHaveLength(3);
  });

  it('maps a 500 on delete to unavailable', async () => {
    const { provider } = setup({ [`DELETE /instance/delete/${NAME}`]: { status: 500, body: {} } });
    expect((await providerError(provider.deleteInstance(NAME))).code).toBe('unavailable');
  });
});

describe('EvolutionProvider.ping', () => {
  it('accepts the recorded 404 of the ping name', async () => {
    const { provider, sent } = setup({
      'GET /instance/fetchInstances': apiFixture('fetch-instances.404-ping'),
    });
    await provider.ping();
    expect(sent[0]?.url).toBe(
      'http://evolution:8080/instance/fetchInstances?instanceName=botcenter-ping',
    );
  });

  it('maps a wrong API key to rejected', async () => {
    const { provider } = setup({
      'GET /instance/fetchInstances': apiFixture('fetch-instances.401-wrong-api-key'),
    });
    expect((await providerError(provider.ping())).code).toBe('rejected');
  });

  it('maps a network error to unavailable', async () => {
    const { provider } = setup({
      'GET /instance/fetchInstances': new TypeError('fetch failed', {
        cause: { code: 'ECONNREFUSED' },
      }),
    });
    const error = await providerError(provider.ping());
    expect(error.code).toBe('unavailable');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('Evolution ping failed: network error');
  });

  it('maps a timeout to unavailable', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const { provider } = setup({ 'GET /instance/fetchInstances': timeout });
    expect((await providerError(provider.ping())).message).toBe(
      'Evolution ping timed out after 10000 ms',
    );
  });

  it('maps a 503 to unavailable', async () => {
    const { provider } = setup({
      'GET /instance/fetchInstances': { status: 503, body: 'Service Unavailable' },
    });
    expect((await providerError(provider.ping())).code).toBe('unavailable');
  });
});

describe('EvolutionProvider.sendMessage', () => {
  const text = {
    to: '5511987654321',
    content: { type: 'text' as const, text: 'Olá! Escolha um horário:' },
  };

  it('sends a text and returns key.id of the recorded answer', async () => {
    const { provider, sent } = setup({
      [`POST /message/sendText/${NAME}`]: apiFixture('send-text.201'),
    });
    const result = await provider.sendMessage(NAME, {
      ...text,
      typingDelayMs: 1200,
      quotedProviderMessageId: '3EB0QUOTED',
    });
    expect(result).toEqual({ providerMessageId: '3EB0FEDCBA9876543210AB' });
    expect(sent[0]?.body).toEqual({
      number: '5511987654321',
      text: 'Olá! Escolha um horário:',
      delay: 1200,
      quoted: { key: { id: '3EB0QUOTED' } },
    });
  });

  it('sends media with the URL', async () => {
    const { provider, sent } = setup({
      [`POST /message/sendMedia/${NAME}`]: apiFixture('send-text.201'),
    });
    await provider.sendMessage(NAME, {
      to: '5511987654321',
      content: {
        type: 'media',
        media_type: 'document',
        url: 'https://r2.example.com/bucket/t1/ficha%20treino.pdf?X-Amz-Signature=abc',
        mime_type: 'application/pdf',
        caption: 'Sua ficha',
      },
    });
    expect(sent[0]?.body).toEqual({
      number: '5511987654321',
      mediatype: 'document',
      media: 'https://r2.example.com/bucket/t1/ficha%20treino.pdf?X-Amz-Signature=abc',
      mimetype: 'application/pdf',
      caption: 'Sua ficha',
      fileName: 'ficha treino.pdf',
    });
  });

  it('sends buttons as a numbered text menu by default', async () => {
    const { provider, sent } = setup({
      [`POST /message/sendText/${NAME}`]: apiFixture('send-text.201'),
    });
    await provider.sendMessage(NAME, {
      to: '5511987654321',
      content: {
        type: 'buttons',
        text: 'Qual plano?',
        buttons: [
          { id: 'm', title: 'Mensal' },
          { id: 'a', title: 'Anual' },
        ],
      },
    });
    expect(sent[0]?.body).toEqual({
      number: '5511987654321',
      text: 'Qual plano?\n\n1. Mensal\n2. Anual',
    });
  });

  it('sends native buttons when the option is "native"', async () => {
    const answers = apiFixture('send-buttons.201');
    const sent: unknown[] = [];
    const provider = new EvolutionProvider({
      baseUrl: 'http://evolution:8080',
      apiKey: API_KEY,
      interactiveFallback: 'native',
      fetch: async (url, init) => {
        sent.push([url, JSON.parse(init.body!)]);
        return { status: answers.status, text: async () => JSON.stringify(answers.body) };
      },
    });
    const result = await provider.sendMessage(NAME, {
      to: '5511987654321',
      content: {
        type: 'buttons',
        text: 'Qual plano?',
        buttons: [{ id: 'plan_monthly', title: 'Mensal' }],
      },
    });
    expect(result.providerMessageId).toBe('3EB0ABCDEF0123456789AB');
    expect(sent[0]).toEqual([
      `http://evolution:8080/message/sendButtons/${NAME}`,
      {
        number: '5511987654321',
        title: 'Qual plano?',
        buttons: [{ type: 'reply', displayText: 'Mensal', id: 'plan_monthly' }],
      },
    ]);
  });

  it('maps the 400 "exists: false" answer to invalid_recipient, without the phone in the message', async () => {
    const { provider, logger } = setup({
      [`POST /message/sendText/${NAME}`]: apiFixture('send-text.400-not-on-whatsapp'),
    });
    const error = await providerError(provider.sendMessage(NAME, text));
    expect(error.code).toBe('invalid_recipient');
    expect(error.retryable).toBe(false);
    expect(error.message).not.toMatch(/5511900000000/);
    expect(logger.lines.join('\n')).not.toMatch(/5511900000000/);
  });

  it.each([
    ['send-text.500-closed', STATE_CLOSE],
    ['send-text.500-connecting', STATE_CONNECTING],
    ['send-media.500-closed', STATE_CLOSE],
  ])('maps the recorded %s answer to not_connected after a state check', async (fixture, state) => {
    const { provider, sent } = setup({
      [`POST /message/sendText/${NAME}`]: apiFixture(fixture),
      [`GET /instance/connectionState/${NAME}`]: state,
    });
    const error = await providerError(provider.sendMessage(NAME, text));
    expect(error.code).toBe('not_connected');
    expect(error.retryable).toBe(true);
    expect(sent.map((s) => s.init.method)).toEqual(['POST', 'GET']);
  });

  it('maps a timeout to not_connected when the instance is connecting', async () => {
    const timeout = new DOMException('timeout', 'TimeoutError');
    const { provider } = setup({
      [`POST /message/sendText/${NAME}`]: timeout,
      [`GET /instance/connectionState/${NAME}`]: STATE_CONNECTING,
    });
    expect((await providerError(provider.sendMessage(NAME, text))).code).toBe('not_connected');
  });

  it('keeps unavailable for a timeout when the instance is connected', async () => {
    const timeout = new DOMException('timeout', 'TimeoutError');
    const { provider } = setup({
      [`POST /message/sendText/${NAME}`]: timeout,
      [`GET /instance/connectionState/${NAME}`]: STATE_OPEN,
    });
    expect((await providerError(provider.sendMessage(NAME, text))).code).toBe('unavailable');
  });

  it('keeps unavailable for a 500 when the state check also fails', async () => {
    const { provider, logger } = setup({
      [`POST /message/sendText/${NAME}`]: { status: 500, body: {} },
      [`GET /instance/connectionState/${NAME}`]: new TypeError('fetch failed'),
    });
    expect((await providerError(provider.sendMessage(NAME, text))).code).toBe('unavailable');
    expect(
      logger.lines.some((line) =>
        line.startsWith('Evolution state check after a failed send failed'),
      ),
    ).toBe(true);
  });

  it('maps a 400 of a connected instance to rejected', async () => {
    const { provider } = setup({
      [`POST /message/sendText/${NAME}`]: {
        status: 400,
        body: { status: 400, response: { message: ['Error: x'] } },
      },
      [`GET /instance/connectionState/${NAME}`]: STATE_OPEN,
    });
    expect((await providerError(provider.sendMessage(NAME, text))).code).toBe('rejected');
  });

  it('maps a missing instance to not_found', async () => {
    const { provider } = setup({
      [`POST /message/sendText/${NAME}`]: apiFixture('send-text.404-missing'),
    });
    expect((await providerError(provider.sendMessage(NAME, text))).code).toBe('not_found');
  });

  it('maps a 2xx answer without key.id to rejected (no retry, no duplicate)', async () => {
    const { provider } = setup({ [`POST /message/sendText/${NAME}`]: { status: 201, body: {} } });
    const error = await providerError(provider.sendMessage(NAME, text));
    expect(error.code).toBe('rejected');
  });

  it('adds the typing delay to the time limit of the send', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const { provider } = setup({ [`POST /message/sendText/${NAME}`]: apiFixture('send-text.201') });
    await provider.sendMessage(NAME, { ...text, typingDelayMs: 5000 });
    expect(spy).toHaveBeenCalledWith(35_000);
    spy.mockRestore();
  });

  it('never puts the message text or the API key in errors or logs', async () => {
    const { provider, logger } = setup({
      [`POST /message/sendText/${NAME}`]: {
        status: 400,
        body: {
          status: 400,
          response: { message: ['Error: Olá! Escolha um horário: 5511987654321'] },
        },
      },
      [`GET /instance/connectionState/${NAME}`]: STATE_OPEN,
    });
    const error = await providerError(provider.sendMessage(NAME, text));
    const output = `${error.message}\n${logger.lines.join('\n')}`;
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain('Olá! Escolha um horário:');
    expect(output).not.toContain('5511987654321');
    expect(logger.lines.join('\n')).toContain('5511*****4321');
  });
});

describe('EvolutionProvider.downloadMedia', () => {
  it('decodes the base64 of the answer', async () => {
    const { provider, sent } = setup({
      [`POST /chat/getBase64FromMediaMessage/${NAME}`]: apiFixture('get-base64.201'),
    });
    const media = await provider.downloadMedia(NAME, '3EB0AABBCCDDEEFF001122');
    expect(media).toEqual({
      data: Buffer.from('fake-jpeg-bytes'),
      mimeType: 'image/jpeg',
      fileName: '3EB0AABBCCDDEEFF001122.jpeg',
    });
    expect(sent[0]?.body).toEqual({
      message: { key: { id: '3EB0AABBCCDDEEFF001122' } },
      convertToMp4: false,
    });
  });

  it('maps the recorded "Message not found" to rejected', async () => {
    const { provider } = setup({
      [`POST /chat/getBase64FromMediaMessage/${NAME}`]: apiFixture(
        'get-base64.400-message-not-found',
      ),
    });
    expect((await providerError(provider.downloadMedia(NAME, 'NOPE'))).code).toBe('rejected');
  });

  it('maps an answer without base64 to rejected', async () => {
    const { provider } = setup({
      [`POST /chat/getBase64FromMediaMessage/${NAME}`]: { status: 201, body: null },
    });
    expect((await providerError(provider.downloadMedia(NAME, 'X'))).code).toBe('rejected');
  });
});

describe('EvolutionProvider: other answers', () => {
  it('maps a 404 of an unknown route to rejected (a configuration error)', async () => {
    const { provider } = setup({
      [`GET /instance/connectionState/${NAME}`]: apiFixture('route.404-missing'),
    });
    expect((await providerError(provider.getConnectionState(NAME))).code).toBe('rejected');
  });

  it.each([408, 429])('maps HTTP %i to unavailable', async (status) => {
    const { provider } = setup({ [`GET /instance/connectionState/${NAME}`]: { status, body: {} } });
    expect((await providerError(provider.getConnectionState(NAME))).code).toBe('unavailable');
  });

  it('accepts a body that is not JSON', async () => {
    const { provider } = setup({});
    const custom = new EvolutionProvider({
      baseUrl: 'http://evolution:8080',
      apiKey: API_KEY,
      fetch: async () => ({ status: 502, text: async () => '<html>Bad Gateway</html>' }),
      logger: silentLogger(),
    });
    expect((await providerError(custom.ping())).httpStatus).toBe(502);
    expect(provider.name).toBe('evolution');
  });
});
