import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv } from './env';

/**
 * Gives the validated environment (`ENV`) to every module. The tests replace the provider with
 * `overrideProvider(ENV).useValue(loadEnv({...}))`, so they do not change `process.env`.
 */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
