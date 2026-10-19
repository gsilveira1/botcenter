import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { ENV, isProduction } from '../config/env';
import type { AppEnv } from '../config/env';
import { EXTERNAL_HTTP, EXTERNAL_HTTP_BINARY } from '../ports/external-http.port';
import { ExternalHttpClient } from './external-http.client';
import { DNS_RESOLVER, SsrfGuard, systemDnsResolver } from './ssrf-guard';
import type { DnsResolver } from './ssrf-guard';

/** Builds the guard from the environment: HTTP and private addresses only outside production. */
export function ssrfGuardFromEnv(env: AppEnv, resolver: DnsResolver): SsrfGuard {
  const production = isProduction(env);
  return new SsrfGuard(resolver, {
    allowHttp: !production,
    allowPrivate: !production && env.EXTERNAL_HTTP_ALLOW_PRIVATE,
  });
}

/** Closes the keep-alive sockets of the client at shutdown. */
@Injectable()
class ExternalHttpShutdown implements OnApplicationShutdown {
  constructor(@Inject(ExternalHttpClient) private readonly client: ExternalHttpClient) {}

  onApplicationShutdown(): void {
    this.client.close();
  }
}

/**
 * The external HTTP client with the SSRF guard, in both processes. It is global: the webhooks slice and
 * the conversations slice inject `EXTERNAL_HTTP` (the frozen port), `ExternalHttpClient`, or `SsrfGuard`.
 * Tests replace `DNS_RESOLVER` with a fake resolver.
 */
@Global()
@Module({
  providers: [
    { provide: DNS_RESOLVER, useValue: systemDnsResolver },
    { provide: SsrfGuard, useFactory: ssrfGuardFromEnv, inject: [ENV, DNS_RESOLVER] },
    {
      provide: ExternalHttpClient,
      useFactory: (guard: SsrfGuard, env: AppEnv) =>
        new ExternalHttpClient(guard, { maxResponseBytes: env.EXTERNAL_HTTP_MAX_RESPONSE_BYTES }),
      inject: [SsrfGuard, ENV],
    },
    { provide: EXTERNAL_HTTP, useExisting: ExternalHttpClient },
    { provide: EXTERNAL_HTTP_BINARY, useExisting: ExternalHttpClient },
    ExternalHttpShutdown,
  ],
  exports: [SsrfGuard, ExternalHttpClient, EXTERNAL_HTTP, EXTERNAL_HTTP_BINARY],
})
export class ExternalHttpModule {}
