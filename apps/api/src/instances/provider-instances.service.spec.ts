import { ProviderError } from '@botcenter/whatsapp-provider';
import { FakeWhatsAppProvider } from '@botcenter/whatsapp-provider/testing';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { AppError } from '../common/errors/app-error';
import type { PrismaService } from '../prisma/prisma.service';
import { ProviderInstancesService, providerFailure } from './provider-instances.service';

function setup() {
  const provider = new FakeWhatsAppProvider();
  const update = vi.fn(async () => 1);
  const prisma = { $executeRaw: update } as unknown as PrismaService;
  const env = testEnv({ INTERNAL_WEBHOOK_BASE_URL: 'http://api:3000/' });
  const service = new ProviderInstancesService(provider, env, prisma);
  const instance = {
    id: '0192a0b0-0000-7000-8000-000000000001',
    tenantId: '0192a0b0-0000-7000-8000-000000000002',
    providerName: 'inst_test',
    providerCreatedAt: null as Date | null,
  };
  return { provider, update, service, instance, env };
}

describe('providerFailure', () => {
  it('maps a transient error to 503 PROVIDER_UNAVAILABLE with Retry-After', () => {
    const error = providerFailure(new ProviderError('unavailable', 'down', 503), 'connect');
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.status).toBe(503);
    expect(error.headers).toEqual({ 'Retry-After': '30' });
  });

  it('maps a refusal to 409 CONFLICT without the provider answer', () => {
    const error = providerFailure(new ProviderError('rejected', 'secret detail', 400), 'delete');
    expect(error.code).toBe('CONFLICT');
    expect(error.detail).not.toContain('secret detail');
  });
});

describe('ProviderInstancesService', () => {
  it('creates the provider instance with the internal webhook URL and secret, then records it', async () => {
    const { provider, update, service, instance, env } = setup();
    await service.create(instance);
    expect(provider.instances.get('inst_test')).toMatchObject({
      webhookUrl: 'http://api:3000/internal/evolution/webhook',
      webhookSecret: env.EVOLUTION_WEBHOOK_SECRET,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]).toEqual(expect.arrayContaining([instance.id, instance.tenantId]));
  });

  it('creates the provider instance before the first connect', async () => {
    const { provider, service, instance } = setup();
    const result = await service.connect(instance, { method: 'qrcode' });
    expect(provider.calls.map((call) => call.method)).toEqual(['createInstance', 'connect']);
    expect(result.alreadyConnected).toBe(false);
    expect(result.qrcodeBase64).toBeDefined();
  });

  it('creates the instance again when the provider lost it, then connects', async () => {
    const { provider, service, instance } = setup();
    const result = await service.connect(
      { ...instance, providerCreatedAt: new Date() },
      { method: 'pairing_code', phone: '5511987654321' },
    );
    expect(provider.calls.map((call) => call.method)).toEqual([
      'connect',
      'createInstance',
      'connect',
    ]);
    expect(result.pairingCode).toMatch(/^[A-Z0-9]{8}$/);
  });

  it('does not create again for another provider error', async () => {
    const { provider, service, instance } = setup();
    provider.failNext('connect', 'unavailable');
    await expect(
      service.connect({ ...instance, providerCreatedAt: new Date() }, { method: 'qrcode' }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(provider.calls.map((call) => call.method)).toEqual(['connect']);
  });

  it('removes an instance that the provider does not know without an error', async () => {
    const { provider, service, instance } = setup();
    await service.remove(instance);
    expect(provider.calls.map((call) => call.method)).toEqual(['logout', 'deleteInstance']);
  });

  it('converts a provider error of a route and keeps other errors', async () => {
    const { service } = setup();
    await expect(
      service.forRoute('delete', 'id', async () => {
        throw new ProviderError('unavailable', 'down');
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await expect(
      service.forRoute('delete', 'id', async () => {
        throw new TypeError('bug');
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
