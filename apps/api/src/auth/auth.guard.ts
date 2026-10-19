import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WEBHOOK_SECRET_HEADER } from '@botcenter/whatsapp-provider';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../common/errors/app-error';
import { isPrivateAddress } from '../common/http/network';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { bindLogContext } from '../logging/log-context';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { ApiKeyAuthenticator } from './api-key.authenticator';
import { ConnectTokenVerifierRegistry } from './connect-token.registry';
import { AUTH_POLICY } from './decorators';
import type { AuthPolicy } from './decorators';

function safeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The global guard. It reads the `AuthPolicy` of the route (`@Public`, `@RequireScope`, `@ConnectToken`,
 * `@Internal`) and refuses a route without a policy.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = getLogger('auth');

  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: AppEnv,
    private readonly authenticator: ApiKeyAuthenticator,
    private readonly rateLimits: RateLimitService,
    private readonly connectTokens: ConnectTokenVerifierRegistry,
    private readonly metrics: MetricsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const policy = this.reflector.getAllAndOverride<AuthPolicy | undefined>(AUTH_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!policy) {
      this.logger.error(
        { route: request.routeOptions?.url, handler: context.getHandler().name },
        'route has no access policy; the request is refused',
      );
      throw new AppError('FORBIDDEN', 'Access denied');
    }
    switch (policy.kind) {
      case 'public':
        return true;
      case 'internal':
        this.checkInternal(request, policy.secret);
        return true;
      case 'connect_token':
        await this.checkConnectToken(request);
        return true;
      case 'scopes':
        await this.checkApiKey(
          request,
          context.switchToHttp().getResponse<FastifyReply>(),
          policy.scopes,
        );
        return true;
    }
  }

  private checkInternal(request: FastifyRequest, requireSecret: boolean): void {
    if (!isPrivateAddress(request.ip)) {
      this.logger.warn(
        { client_ip: request.ip, route: request.routeOptions?.url },
        'internal route refused: public address',
      );
      this.metrics.internalRefusedTotal.inc({ reason: 'public_address' });
      // 404, not 403: an internal route does not exist for the internet.
      throw new AppError('NOT_FOUND', 'Not found');
    }
    if (!requireSecret) {
      return;
    }
    const secret = header(request, WEBHOOK_SECRET_HEADER);
    if (!secret || !safeEqual(secret, this.env.EVOLUTION_WEBHOOK_SECRET)) {
      this.logger.warn(
        { client_ip: request.ip, route: request.routeOptions?.url },
        'internal route refused: wrong secret',
      );
      this.metrics.internalRefusedTotal.inc({ reason: 'wrong_secret' });
      // Evolution does not retry a 401: a wrong secret is a configuration error, not a transient one.
      throw new AppError('UNAUTHENTICATED', 'Invalid internal secret');
    }
  }

  private async checkConnectToken(request: FastifyRequest): Promise<void> {
    await this.rateLimits.consumeConnect(request.ip);
    const verifier = this.connectTokens.get();
    if (!verifier) {
      this.logger.error(
        { route: request.routeOptions?.url },
        'no connect token verifier is registered',
      );
      throw new AppError('CONNECT_TOKEN_INVALID', 'The connect token is not valid');
    }
    const token = await verifier.verify(request);
    request.connectToken = token;
    bindLogContext({ tenant_id: token.tenantId, instance_id: token.instanceId });
  }

  /** A 401 counts as one failed authentication of the client address (SEC-10). */
  private async authenticate(request: FastifyRequest) {
    try {
      return await this.authenticator.authenticate(header(request, 'authorization'), request.ip);
    } catch (error) {
      if (error instanceof AppError && error.code === 'UNAUTHENTICATED') {
        await this.rateLimits.recordAuthFailure(request.ip);
      }
      throw error;
    }
  }

  private async checkApiKey(
    request: FastifyRequest,
    reply: FastifyReply,
    scopes: readonly string[],
  ): Promise<void> {
    await this.rateLimits.assertAuthFailuresBelowLimit(request.ip);
    const { context, rateLimitPerMinute } = await this.authenticate(request);
    request.auth = context;
    bindLogContext({ tenant_id: context.tenantId });
    const missing = scopes.filter((scope) => !context.scopes.includes(scope as never));
    if (missing.length > 0) {
      throw new AppError('SCOPE_MISSING', `The API key needs the scope: ${missing.join(', ')}`);
    }
    const { headers } = await this.rateLimits.consumeKey(context.keyId, rateLimitPerMinute);
    if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        void reply.header(name, value);
      }
    }
  }
}
