import { EvolutionProvider, EvolutionWebhookNormalizer } from '@botcenter/whatsapp-provider';
import { getLogger } from '../logging/logger';
import { pinoProviderLogger } from './provider-logger';
import type { ProviderFactory } from './provider.tokens';

/**
 * The provider of the process: the Evolution API adapter and the normalizer of the Evolution webhooks.
 * This function is the only switch point of the provider. `ProviderModule` calls `close()` when the
 * application shuts down, so the keep-alive connections to Evolution close in both processes.
 */
export const providerFactory: ProviderFactory = (env) => {
  const provider = new EvolutionProvider({
    baseUrl: env.EVOLUTION_URL,
    apiKey: env.EVOLUTION_API_KEY,
    logger: pinoProviderLogger(getLogger('whatsapp-provider')),
    timeouts: {
      requestMs: env.EVOLUTION_REQUEST_TIMEOUT_MS,
      connectMs: env.EVOLUTION_CONNECT_TIMEOUT_MS,
      sendMs: env.EVOLUTION_SEND_TIMEOUT_MS,
      mediaMs: env.EVOLUTION_MEDIA_TIMEOUT_MS,
    },
    interactiveFallback: env.EVOLUTION_INTERACTIVE_FALLBACK,
  });
  return {
    provider,
    normalizer: new EvolutionWebhookNormalizer(),
    close: () => provider.close(),
  };
};
