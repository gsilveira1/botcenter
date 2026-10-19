import 'reflect-metadata';
import { Writable } from 'node:stream';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EvolutionWebhookNormalizer } from '@botcenter/whatsapp-provider';
import { FakeWhatsAppProvider } from '@botcenter/whatsapp-provider/testing';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { ENV } from '../config/env';
import { createRootLogger } from '../logging/logger';
import { ProviderModule } from './provider.module';
import {
  PROVIDER_BINDINGS,
  PROVIDER_WEBHOOK_NORMALIZER,
  WHATSAPP_PROVIDER,
} from './provider.tokens';
import type { ProviderBindings } from './provider.tokens';

@Global()
@Module({ providers: [{ provide: ENV, useValue: testEnv() }], exports: [ENV] })
class TestConfigModule {}

function captureLogs(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  createRootLogger('info', stream);
  return lines;
}

async function start(bindings: ProviderBindings) {
  const moduleRef = await Test.createTestingModule({
    imports: [TestConfigModule, ProviderModule],
  })
    .overrideProvider(PROVIDER_BINDINGS)
    .useValue(bindings)
    .compile();
  await moduleRef.init();
  return moduleRef;
}

describe('ProviderModule', () => {
  it('gives the provider and the normalizer of the bindings', async () => {
    const bindings = {
      provider: new FakeWhatsAppProvider(),
      normalizer: new EvolutionWebhookNormalizer(),
    };
    const moduleRef = await start(bindings);
    expect(moduleRef.get(WHATSAPP_PROVIDER)).toBe(bindings.provider);
    expect(moduleRef.get(PROVIDER_WEBHOOK_NORMALIZER)).toBe(bindings.normalizer);
    await moduleRef.close();
  });

  it('closes the provider one time when the application shuts down', async () => {
    const close = vi.fn(async () => undefined);
    const moduleRef = await start({
      provider: new FakeWhatsAppProvider(),
      normalizer: new EvolutionWebhookNormalizer(),
      close,
    });
    expect(close).not.toHaveBeenCalled();

    await moduleRef.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('logs a failed close at error and lets the shutdown continue', async () => {
    const lines = captureLogs();
    const moduleRef = await start({
      provider: new FakeWhatsAppProvider(),
      normalizer: new EvolutionWebhookNormalizer(),
      close: () => Promise.reject(new Error('agent close failed')),
    });

    await expect(moduleRef.close()).resolves.toBeUndefined();

    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'WhatsApp provider not closed' }),
    );
  });
});
