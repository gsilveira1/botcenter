import type { ProviderWebhookNormalizer, WhatsAppProvider } from '@botcenter/whatsapp-provider';
import type { AppEnv } from '../config/env';

/** DI token of the `WhatsAppProvider` (type from `@botcenter/whatsapp-provider`). */
export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
/** DI token of the `ProviderWebhookNormalizer` (type from `@botcenter/whatsapp-provider`). */
export const PROVIDER_WEBHOOK_NORMALIZER = Symbol('PROVIDER_WEBHOOK_NORMALIZER');
/** DI token of the pair. The tests replace this one provider with a fake pair. */
export const PROVIDER_BINDINGS = Symbol('PROVIDER_BINDINGS');

export interface ProviderBindings {
  provider: WhatsAppProvider;
  normalizer: ProviderWebhookNormalizer;
  /**
   * Frees the resources of the provider (for example the keep-alive connections). `ProviderModule`
   * calls it one time when the application shuts down. A test pair can omit it.
   */
  close?: () => Promise<void>;
}

/** Makes the provider pair from the environment. `provider.factory.ts` holds the factory of the process. */
export type ProviderFactory = (env: AppEnv) => ProviderBindings;
