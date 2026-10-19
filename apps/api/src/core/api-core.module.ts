import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ApiKeyAuthenticator } from '../auth/api-key.authenticator';
import { AuthGuard } from '../auth/auth.guard';
import { ConnectTokenVerifierRegistry } from '../auth/connect-token.registry';
import { ProblemDetailsFilter } from '../common/errors/problem-details.filter';
import { ZodValidationPipe } from '../common/zod-dto';
import { HealthController } from '../health/health.controller';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { SharedStateMetricsCollector } from '../queues/queue-metrics.collector';
import { RateLimitService } from '../rate-limit/rate-limit.service';

/**
 * The HTTP pipeline of the API process: the global guard (access policies, API keys, rate limit), the
 * Zod validation pipe, the idempotency interceptor, the Problem Details filter, health, and `/metrics`.
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [
    ApiKeyAuthenticator,
    RateLimitService,
    ConnectTokenVerifierRegistry,
    IdempotencyService,
    SharedStateMetricsCollector,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
  exports: [ConnectTokenVerifierRegistry, RateLimitService],
})
export class ApiCoreModule {}
