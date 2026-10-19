import type { ProviderFactory } from './provider.tokens';
import { unconfiguredBindings } from './unconfigured-provider';

/**
 * The provider of the process. The orchestrator changes only this function when the Evolution adapter of
 * `@botcenter/whatsapp-provider` is merged, for example:
 *
 *   export const providerFactory: ProviderFactory = (env) => ({
 *     provider: new EvolutionProvider({ baseUrl: env.EVOLUTION_URL, apiKey: env.EVOLUTION_API_KEY }),
 *     normalizer: new EvolutionWebhookNormalizer(),
 *   });
 */
export const providerFactory: ProviderFactory = () => unconfiguredBindings();
