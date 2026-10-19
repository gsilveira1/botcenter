import { ProviderError } from '@botcenter/whatsapp-provider';
import { describe, expect, it } from 'vitest';
import { providerFactory } from './provider.factory';

describe('unconfigured provider', () => {
  it('fails every call with ProviderError unavailable, so readiness reports it', async () => {
    const { provider, normalizer } = providerFactory({} as never);
    expect(provider.name).toBe('unconfigured');
    await expect(provider.ping()).rejects.toBeInstanceOf(ProviderError);
    await expect(
      provider.sendMessage('inst_x', { to: '5511987654321', content: { type: 'text', text: 'x' } }),
    ).rejects.toMatchObject({
      code: 'unavailable',
      retryable: true,
    });
    expect(() => normalizer.normalize({})).toThrow(ProviderError);
  });
});
