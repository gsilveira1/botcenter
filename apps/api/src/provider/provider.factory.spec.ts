import {
  EvolutionProvider,
  EvolutionWebhookNormalizer,
  ProviderError,
} from '@botcenter/whatsapp-provider';
import type { OutboundContent } from '@botcenter/whatsapp-provider';
import { FakeEvolutionServer } from '@botcenter/whatsapp-provider/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from '../../test/support/env';
import { providerFactory } from './provider.factory';
import type { ProviderBindings } from './provider.tokens';

const API_KEY = 'factory-test-key';
const OWNER_PHONE = '5511912345678';

let fake: FakeEvolutionServer;
const opened: ProviderBindings[] = [];

beforeAll(async () => {
  // No webhook receiver exists in this test: the fake must not send automatic webhooks.
  fake = await FakeEvolutionServer.start({ apiKey: API_KEY, autoWebhooks: false });
});

afterEach(async () => {
  for (const bindings of opened.splice(0)) {
    await bindings.close?.();
  }
  fake.clearCalls();
  fake.clearFailures();
});

afterAll(async () => {
  await fake?.close();
});

function bind(overrides: Record<string, string> = {}): ProviderBindings {
  const bindings = providerFactory(
    testEnv({ EVOLUTION_URL: fake.url, EVOLUTION_API_KEY: API_KEY, ...overrides }),
  );
  opened.push(bindings);
  return bindings;
}

async function connectedInstance(bindings: ProviderBindings): Promise<string> {
  const name = `inst_${crypto.randomUUID()}`;
  await bindings.provider.createInstance({
    name,
    webhookUrl: 'http://api.test:3000/internal/evolution/webhook',
    webhookSecret: 's'.repeat(32),
  });
  fake.setState(name, 'open', OWNER_PHONE);
  return name;
}

const BUTTONS: OutboundContent = {
  type: 'buttons',
  text: 'Confirma?',
  buttons: [
    { id: 'yes', title: 'Sim' },
    { id: 'no', title: 'Não' },
  ],
};

describe('providerFactory', () => {
  it('binds the Evolution adapter and the Evolution normalizer to the environment', async () => {
    const bindings = bind();
    expect(bindings.provider).toBeInstanceOf(EvolutionProvider);
    expect(bindings.provider.name).toBe('evolution');
    expect(bindings.normalizer).toBeInstanceOf(EvolutionWebhookNormalizer);

    await bindings.provider.ping();

    const [ping] = fake.callsTo('/instance/fetchInstances', 'GET');
    expect(ping?.headers['apikey']).toBe(API_KEY);
  });

  it('reports a wrong API key as a rejected provider call', async () => {
    const bindings = bind({ EVOLUTION_API_KEY: 'wrong-key' });
    await expect(bindings.provider.ping()).rejects.toMatchObject({
      code: 'rejected',
      httpStatus: 401,
    });
  });

  it('sends buttons as a numbered text menu by default', async () => {
    const bindings = bind();
    const name = await connectedInstance(bindings);

    await bindings.provider.sendMessage(name, { to: '5511987654321', content: BUTTONS });

    expect(fake.callsTo('/message/sendText', 'POST')).toHaveLength(1);
    expect(fake.callsTo('/message/sendButtons', 'POST')).toHaveLength(0);
  });

  it('sends native buttons when EVOLUTION_INTERACTIVE_FALLBACK is native', async () => {
    const bindings = bind({ EVOLUTION_INTERACTIVE_FALLBACK: 'native' });
    const name = await connectedInstance(bindings);

    await bindings.provider.sendMessage(name, { to: '5511987654321', content: BUTTONS });

    expect(fake.callsTo('/message/sendButtons', 'POST')).toHaveLength(1);
  });

  it('uses EVOLUTION_REQUEST_TIMEOUT_MS as the time limit of a request', async () => {
    const bindings = bind({ EVOLUTION_REQUEST_TIMEOUT_MS: '200' });
    fake.failNext({ route: '/instance/fetchInstances', hang: true });

    const started = Date.now();
    const error = await bindings.provider.ping().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('gives a close function that closes the keep-alive connections of the adapter', async () => {
    const bindings = providerFactory(
      testEnv({ EVOLUTION_URL: fake.url, EVOLUTION_API_KEY: API_KEY }),
    );
    await bindings.provider.ping();

    await expect(bindings.close?.()).resolves.toBeUndefined();
    await expect(bindings.provider.ping()).rejects.toMatchObject({ code: 'unavailable' });
  });
});
