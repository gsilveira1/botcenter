import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  TestContainers,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderLogger } from '../logger.js';
import { ProviderError, type ProviderEvent, WEBHOOK_SECRET_HEADER } from '../types.js';
import { EvolutionProvider } from './evolution-provider.js';
import { EvolutionWebhookNormalizer } from './webhook-normalizer.js';

/**
 * Integration test with the real `evoapicloud/evolution-api:v2.3.7` image, PostgreSQL 16, and Redis 7.
 * No phone is necessary. The QR code test needs internet access from Docker (WhatsApp servers).
 */

const EVOLUTION_IMAGE = 'evoapicloud/evolution-api:v2.3.7';
const API_KEY = 'int-test-global-key-0123456789abcdef';
const SECRET_1 = 'whsec_first';
const SECRET_2 = 'whsec_second';

/** The environment of the Evolution container. The README lists the same values for production. */
function evolutionEnvironment(): Record<string, string> {
  return {
    TZ: 'UTC',
    SERVER_URL: 'http://evolution:8080',
    SERVER_DISABLE_MANAGER: 'true',
    SERVER_DISABLE_DOCS: 'true',
    AUTHENTICATION_API_KEY: API_KEY,
    AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES: 'false',
    DATABASE_PROVIDER: 'postgresql',
    DATABASE_CONNECTION_URI:
      'postgresql://evolution:evolution@postgres:5432/evolution?schema=public',
    DATABASE_CONNECTION_CLIENT_NAME: 'botcenter',
    DATABASE_SAVE_DATA_INSTANCE: 'true',
    DATABASE_SAVE_DATA_NEW_MESSAGE: 'true',
    DATABASE_SAVE_MESSAGE_UPDATE: 'false',
    DATABASE_SAVE_DATA_CONTACTS: 'false',
    DATABASE_SAVE_DATA_CHATS: 'false',
    DATABASE_SAVE_DATA_HISTORIC: 'false',
    DATABASE_SAVE_DATA_LABELS: 'false',
    DATABASE_SAVE_IS_ON_WHATSAPP: 'false',
    CACHE_REDIS_ENABLED: 'true',
    CACHE_REDIS_URI: 'redis://redis:6379/1',
    CACHE_REDIS_PREFIX_KEY: 'evolution',
    CACHE_REDIS_SAVE_INSTANCES: 'false',
    CACHE_LOCAL_ENABLED: 'false',
    DEL_INSTANCE: 'false',
    WEBHOOK_GLOBAL_ENABLED: 'false',
    WEBSOCKET_ENABLED: 'false',
    TELEMETRY_ENABLED: 'false',
    LOG_LEVEL: 'ERROR,WARN,INFO',
    LOG_BAILEYS: 'error',
    LOG_COLOR: 'false',
    QRCODE_LIMIT: '30',
  };
}

const logger: ProviderLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Receives the webhooks of the container on the host and normalizes them. */
class WebhookReceiver {
  readonly events: ProviderEvent[] = [];
  readonly secrets: string[] = [];
  private readonly normalizer = new EvolutionWebhookNormalizer();
  private readonly server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        this.secrets.push(String(req.headers[WEBHOOK_SECRET_HEADER]));
        this.events.push(...this.normalizer.normalize(JSON.parse(raw)).events);
        res.writeHead(200);
        res.end();
      });
    });
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '0.0.0.0', resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async waitFor(
    predicate: (event: ProviderEvent) => boolean,
    timeoutMs = 60_000,
  ): Promise<ProviderEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.events.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`No matching webhook event in ${timeoutMs} ms`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

async function errorOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('The promise did not reject');
}

let network: StartedNetwork;
let postgres: StartedPostgreSqlContainer;
let redis: StartedTestContainer;
let evolution: StartedTestContainer;
let receiver: WebhookReceiver;
let provider: EvolutionProvider;
let webhookUrl: string;

beforeAll(async () => {
  receiver = new WebhookReceiver();
  const receiverPort = await receiver.start();
  await TestContainers.exposeHostPorts(receiverPort);
  webhookUrl = `http://host.testcontainers.internal:${receiverPort}/internal/evolution/webhook`;

  network = await new Network().start();
  [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine')
      .withNetwork(network)
      .withNetworkAliases('postgres')
      .withDatabase('evolution')
      .withUsername('evolution')
      .withPassword('evolution')
      .start(),
    new GenericContainer('redis:7-alpine')
      .withNetwork(network)
      .withNetworkAliases('redis')
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start(),
  ]);
  evolution = await new GenericContainer(EVOLUTION_IMAGE)
    .withNetwork(network)
    .withNetworkAliases('evolution')
    .withEnvironment(evolutionEnvironment())
    .withExposedPorts(8080)
    .withWaitStrategy(
      // `GET /` calls web.whatsapp.com. A guarded route without the key answers 401 at once.
      Wait.forHttp('/instance/fetchInstances', 8080).forStatusCode(401),
    )
    .withStartupTimeout(240_000)
    .start();

  provider = new EvolutionProvider({
    baseUrl: `http://${evolution.getHost()}:${evolution.getMappedPort(8080)}`,
    apiKey: API_KEY,
    logger,
    timeouts: { sendMs: 5_000 },
  });
}, 300_000);

afterAll(async () => {
  await provider?.close();
  await evolution?.stop();
  await Promise.all([postgres?.stop(), redis?.stop()]);
  await network?.stop();
  await receiver?.close();
}, 120_000);

describe('EvolutionProvider with the real Evolution API 2.3.7', () => {
  const name = `inst_${crypto.randomUUID()}`;
  const pairingName = `inst_${crypto.randomUUID()}`;

  it('answers the ping, and refuses a wrong API key', async () => {
    await expect(provider.ping()).resolves.toBeUndefined();
    const wrong = new EvolutionProvider({
      baseUrl: `http://${evolution.getHost()}:${evolution.getMappedPort(8080)}`,
      apiKey: 'wrong',
      logger,
    });
    expect(await errorOf(wrong.ping())).toMatchObject({ code: 'rejected', httpStatus: 401 });
    await wrong.close();
  });

  it('creates an instance twice (idempotent) and updates the webhook secret', async () => {
    await provider.createInstance({ name, webhookUrl, webhookSecret: SECRET_1 });
    await provider.createInstance({ name, webhookUrl, webhookSecret: SECRET_2 });
    expect(await provider.getConnectionState(name)).toBe('disconnected');
  });

  it('maps a send to an instance without a session to not_connected', async () => {
    const error = await errorOf(
      provider.sendMessage(name, { to: '5511987654321', content: { type: 'text', text: 'Olá' } }),
    );
    expect(error.code).toBe('not_connected');
    expect(error.retryable).toBe(true);
  });

  it('connects with a QR code, and the webhooks bring the QR code with the secret header', async () => {
    let result = await provider.connect(name, { method: 'qrcode' });
    for (let attempt = 0; !result.qrcode && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      result = await provider.connect(name, { method: 'qrcode' });
    }
    expect(result.alreadyConnected).toBe(false);
    expect(result.qrcode).toMatch(/^2@/);
    expect(result.qrcodeBase64).toMatch(/^data:image\/png;base64,/);

    const qrEvent = await receiver.waitFor(
      (event) => event.kind === 'qrcode.updated' && event.instanceName === name,
    );
    expect(qrEvent).toMatchObject({ kind: 'qrcode.updated', qrcode: expect.stringMatching(/^2@/) });
    await receiver.waitFor(
      (event) =>
        event.kind === 'connection.updated' &&
        event.instanceName === name &&
        event.state === 'connecting',
    );
    expect(new Set(receiver.secrets)).toEqual(new Set([SECRET_2]));
    expect(await provider.getConnectionState(name)).toBe('connecting');
  }, 90_000);

  it('maps a send during the connect flow to not_connected', async () => {
    const error = await errorOf(
      provider.sendMessage(name, { to: '5511987654321', content: { type: 'text', text: 'Olá' } }),
    );
    expect(error.code).toBe('not_connected');
  }, 60_000);

  it('returns a pairing code for the pairing code method', async () => {
    await provider.createInstance({ name: pairingName, webhookUrl, webhookSecret: SECRET_1 });
    let result = await provider.connect(pairingName, {
      method: 'pairing_code',
      phone: '5511987654321',
    });
    for (let attempt = 0; !result.pairingCode && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      result = await provider.connect(pairingName, {
        method: 'pairing_code',
        phone: '5511987654321',
      });
    }
    expect(result.pairingCode).toMatch(/^[A-Z0-9]{8}$/);
  }, 90_000);

  it('maps a media download of an unknown message to rejected', async () => {
    expect((await errorOf(provider.downloadMedia(name, '3EB0000000000000000000'))).code).toBe(
      'rejected',
    );
  });

  it('logs out: the webhook reports logged_out, and a second logout is a success', async () => {
    await provider.logout(name);
    const event = await receiver.waitFor(
      (item) =>
        item.kind === 'connection.updated' &&
        item.instanceName === name &&
        item.state === 'logged_out',
    );
    expect(event).toMatchObject({ reason: 'logged_out' });
    await provider.logout(name);
    expect(await provider.getConnectionState(name)).toBe('disconnected');
  }, 60_000);

  it('deletes the instances, and a delete of a missing instance is a success', async () => {
    await provider.deleteInstance(name);
    await provider.deleteInstance(pairingName);
    // Evolution removes the instance from memory in the background.
    let code = '';
    for (let attempt = 0; code !== 'not_found' && attempt < 20; attempt += 1) {
      code = (await errorOf(provider.getConnectionState(name)).catch(() => ({ code: '' }))).code;
      if (code !== 'not_found') await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(code).toBe('not_found');
    await expect(provider.deleteInstance(name)).resolves.toBeUndefined();
  }, 60_000);
});
