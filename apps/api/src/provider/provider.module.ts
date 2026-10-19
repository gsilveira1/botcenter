import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { getLogger } from '../logging/logger';
import { providerFactory } from './provider.factory';
import {
  PROVIDER_BINDINGS,
  PROVIDER_WEBHOOK_NORMALIZER,
  WHATSAPP_PROVIDER,
} from './provider.tokens';
import type { ProviderBindings } from './provider.tokens';

/**
 * Writes the provider name at start and closes the provider at shutdown. Nest runs
 * `onApplicationShutdown` after the HTTP server and the queue workers stop, so no call is in progress.
 */
@Injectable()
class ProviderLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = getLogger('provider');

  constructor(@Inject(PROVIDER_BINDINGS) private readonly bindings: ProviderBindings) {}

  onApplicationBootstrap(): void {
    this.logger.info({ provider: this.bindings.provider.name }, 'WhatsApp provider wired');
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.bindings.close) {
      return;
    }
    try {
      await this.bindings.close();
      this.logger.info({ provider: this.bindings.provider.name }, 'WhatsApp provider closed');
    } catch (error) {
      // The process stops after this hook, so an open socket has no effect on the operation. The other
      // shutdown hooks (Redis, PostgreSQL) must still run, so the error does not stop the shutdown.
      this.logger.error(
        { err: error, provider: this.bindings.provider.name },
        'WhatsApp provider not closed',
      );
    }
  }
}

/**
 * Gives `WHATSAPP_PROVIDER` and `PROVIDER_WEBHOOK_NORMALIZER` to every module. The pair comes from
 * `providerFactory` (`provider.factory.ts`). Tests replace `PROVIDER_BINDINGS` with a fake pair.
 * At shutdown, the module calls `ProviderBindings.close()`.
 */
@Global()
@Module({
  providers: [
    {
      provide: PROVIDER_BINDINGS,
      inject: [ENV],
      useFactory: (env: AppEnv) => providerFactory(env),
    },
    {
      provide: WHATSAPP_PROVIDER,
      inject: [PROVIDER_BINDINGS],
      useFactory: (bindings: ProviderBindings) => bindings.provider,
    },
    {
      provide: PROVIDER_WEBHOOK_NORMALIZER,
      inject: [PROVIDER_BINDINGS],
      useFactory: (bindings: ProviderBindings) => bindings.normalizer,
    },
    ProviderLifecycle,
  ],
  exports: [WHATSAPP_PROVIDER, PROVIDER_WEBHOOK_NORMALIZER],
})
export class ProviderModule {}
