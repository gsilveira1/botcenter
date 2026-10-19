import { Global, Module } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
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

@Injectable()
class ProviderStartupLog implements OnApplicationBootstrap {
  constructor(@Inject(PROVIDER_BINDINGS) private readonly bindings: ProviderBindings) {}

  onApplicationBootstrap(): void {
    const logger = getLogger('provider');
    if (this.bindings.provider.name === 'unconfigured') {
      logger.warn(
        'no WhatsApp provider is wired: provider calls fail and /health/ready reports it',
      );
    } else {
      logger.info({ provider: this.bindings.provider.name }, 'WhatsApp provider wired');
    }
  }
}

/**
 * Gives `WHATSAPP_PROVIDER` and `PROVIDER_WEBHOOK_NORMALIZER` to every module. The pair comes from
 * `providerFactory` (`provider.factory.ts`). Tests replace `PROVIDER_BINDINGS` with a fake pair.
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
    ProviderStartupLog,
  ],
  exports: [WHATSAPP_PROVIDER, PROVIDER_WEBHOOK_NORMALIZER],
})
export class ProviderModule {}
