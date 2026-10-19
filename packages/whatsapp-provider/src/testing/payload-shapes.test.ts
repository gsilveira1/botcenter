import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiFixture, webhookFixture } from '../test-support/fixtures.js';
import {
  connectionData,
  createInstanceResponse,
  errorBody,
  qrcodeData,
  sentMessageRaw,
  updateData,
  upsertData,
  webhookEnvelope,
} from './evolution-payloads.js';
import { FakeEvolutionServer } from './fake-evolution-server.js';

/**
 * Contract test of the fake: each payload of the fake has only paths that the recorded (or source)
 * fixture also has, with the same JSON type. So a consumer that reads a field of a fake payload
 * also finds it in a real payload.
 */

type Shape = Map<string, string>;

function shapeOf(value: unknown, path = '$', shape: Shape = new Map()): Shape {
  if (value === null) {
    shape.set(path, 'null');
  } else if (Array.isArray(value)) {
    shape.set(path, 'array');
    value.forEach((item) => shapeOf(item, `${path}[]`, shape));
  } else if (typeof value === 'object') {
    shape.set(path, 'object');
    for (const [key, item] of Object.entries(value)) shapeOf(item, `${path}.${key}`, shape);
  } else {
    shape.set(path, typeof value);
  }
  return shape;
}

function expectSubsetShape(fake: unknown, real: unknown): void {
  const realShape = shapeOf(real);
  const problems = [...shapeOf(fake)]
    .filter(
      ([path, type]) => realShape.get(path) !== type && !(type === 'null' && realShape.has(path)),
    )
    .map(([path, type]) => `${path}: fake ${type}, real ${realShape.get(path) ?? 'missing'}`);
  expect(problems).toEqual([]);
}

const INST = 'inst_0192f1a4-7c2e-7b51-9a0e-3f5d2c8b6e41';
const options = { destination: 'http://api/hook', serverUrl: 'http://evolution:8080' };
const owner = { ...options, sender: '5511912345678@s.whatsapp.net' };

describe('fake webhook payloads have the shape of the fixtures', () => {
  it.each([
    [
      'connection-update.connecting',
      webhookEnvelope('connection.update', INST, connectionData(INST, 'connecting', 200), options),
    ],
    [
      'connection-update.close-401',
      webhookEnvelope('connection.update', INST, connectionData(INST, 'close', 401), options),
    ],
    [
      'connection-update.open',
      webhookEnvelope(
        'connection.update',
        INST,
        connectionData(INST, 'open', 200, { phone: '5511912345678' }),
        owner,
      ),
    ],
    [
      'qrcode-updated',
      webhookEnvelope(
        'qrcode.updated',
        INST,
        qrcodeData(INST, { code: '2@x', base64: 'data:x', pairingCode: null }),
        options,
      ),
    ],
    [
      'qrcode-updated.pairing-code',
      webhookEnvelope(
        'qrcode.updated',
        INST,
        qrcodeData(INST, { code: '2@x', base64: 'data:x', pairingCode: 'ABCD1234' }),
        options,
      ),
    ],
    [
      'messages-upsert.text',
      webhookEnvelope(
        'messages.upsert',
        INST,
        upsertData({ conversation: 'Oi' }, 'conversation', {
          from: '5511987654321',
          instanceId: 'i',
        }),
        owner,
      ),
    ],
    [
      'messages-upsert.buttons-response',
      webhookEnvelope(
        'messages.upsert',
        INST,
        upsertData(
          { buttonsResponseMessage: { selectedButtonId: 'a', selectedDisplayText: 'A', type: 1 } },
          'buttonsResponseMessage',
          { from: '5511987654321', instanceId: 'i' },
        ),
        owner,
      ),
    ],
    [
      'messages-update.delivery-ack',
      webhookEnvelope(
        'messages.update',
        INST,
        updateData('3EB0', '5511987654321', 'DELIVERY_ACK', 'i'),
        owner,
      ),
    ],
  ])('%s', (fixture, fake) => {
    expectSubsetShape(fake, webhookFixture(fixture));
  });
});

describe('fake API answers have the shape of the recorded answers', () => {
  it('create instance (201)', () => {
    const body = {
      instanceName: INST,
      integration: 'WHATSAPP-BAILEYS',
      webhook: {
        url: 'http://h',
        headers: { 'x-botcenter-webhook-secret': 's' },
        byEvents: false,
        base64: false,
      },
    };
    const fake = createInstanceResponse(body, 'id', { rejectCall: false, groupsIgnore: true });
    expectSubsetShape(fake, apiFixture('create-instance.201').body);
  });

  it('send (201)', () => {
    const fake = sentMessageRaw(
      '5511987654321',
      '3EB0',
      { conversation: 'x' },
      'conversation',
      'i',
    );
    expectSubsetShape(fake, apiFixture('send-text.201').body);
  });

  it('errors', () => {
    expectSubsetShape(errorBody(404, ['x']), apiFixture('connection-state.404-missing').body);
    expectSubsetShape(
      errorBody(401, 'Unauthorized'),
      apiFixture('fetch-instances.401-wrong-api-key').body,
    );
    expectSubsetShape(errorBody(500, 'x'), apiFixture('send-text.500-closed').body);
  });
});

describe('FakeEvolutionServer answers like the recorded container', () => {
  let fake: FakeEvolutionServer;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fake.url}${path}`, {
      method,
      headers: { apikey: fake.apiKey, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };

  beforeAll(async () => {
    fake = await FakeEvolutionServer.start({ autoWebhooks: false });
  });

  afterAll(async () => {
    await fake.close();
  });

  it('follows the recorded sequence of a new instance', async () => {
    const created = await call('POST', '/instance/create', {
      instanceName: INST,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: false,
      webhook: { enabled: true, url: 'http://127.0.0.1:9/hook', headers: {}, events: [] },
    });
    expect(created.status).toBe(201);
    expectSubsetShape(created.body, apiFixture('create-instance.201').body);

    const steps: [string, string, string, unknown?][] = [
      [
        'create-instance.403-already-in-use',
        'POST',
        '/instance/create',
        { instanceName: INST, integration: 'WHATSAPP-BAILEYS' },
      ],
      ['fetch-instances.404-ping', 'GET', '/instance/fetchInstances?instanceName=botcenter-ping'],
      ['connection-state.200-close', 'GET', `/instance/connectionState/${INST}`],
      [
        'send-text.500-closed',
        'POST',
        `/message/sendText/${INST}`,
        { number: '5511987654321', text: 'hi' },
      ],
      ['logout.400-not-connected', 'DELETE', `/instance/logout/${INST}`],
      [
        'get-base64.400-message-not-found',
        'POST',
        `/chat/getBase64FromMediaMessage/${INST}`,
        { message: { key: { id: 'NOPE' } } },
      ],
      ['connection-state.404-missing', 'GET', '/instance/connectionState/inst_missing'],
      ['connect.200-qrcode', 'GET', `/instance/connect/${INST}`],
      ['connection-state.200-connecting', 'GET', `/instance/connectionState/${INST}`],
      [
        'send-text.500-connecting',
        'POST',
        `/message/sendText/${INST}`,
        { number: '5511987654321', text: 'hi' },
      ],
      ['logout.200', 'DELETE', `/instance/logout/${INST}`],
      ['delete.200', 'DELETE', `/instance/delete/${INST}`],
    ];
    for (const [fixture, method, path, body] of steps) {
      const real = apiFixture(fixture);
      const answer = await call(method, path, body);
      expect({ fixture, status: answer.status }).toEqual({ fixture, status: real.status });
      expectSubsetShape(answer.body, real.body);
      if (real.status >= 400) {
        // The error texts are the same, except the instance names in them.
        expect(JSON.stringify(answer.body).replace(/inst_[\w-]+|botcenter-ping/g, 'N')).toBe(
          JSON.stringify(real.body).replace(/inst_[\w-]+|botcenter-ping/g, 'N'),
        );
      }
    }
  });
});
