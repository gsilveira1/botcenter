import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { AppError } from '../common/errors/app-error';
import { MetricsService } from '../metrics/metrics.service';
import type { RateLimitService } from '../rate-limit/rate-limit.service';
import type { ApiKeyAuthenticator } from './api-key.authenticator';
import { AuthGuard } from './auth.guard';
import { ConnectTokenVerifierRegistry } from './connect-token.registry';
import { ConnectToken, Internal, Public, RequireScope } from './decorators';

const env = testEnv();

class Routes {
  @Public() open() {}
  @RequireScope('messages:send') send() {}
  @RequireScope('messages:send', 'bots:write') both() {}
  @Internal() webhook() {}
  @Internal({ secret: false }) metrics() {}
  @ConnectToken() events() {}
  bare() {}
}

function context(handler: keyof Routes, request: Record<string, unknown>) {
  const reply = { header: vi.fn() };
  const ctx = {
    getType: () => 'http',
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as unknown as ExecutionContext;
  return { ctx, reply };
}

function build(options: { scopes?: string[]; rateLimit?: () => Promise<unknown> } = {}) {
  const authenticator = {
    authenticate: vi.fn(async () => ({
      context: {
        tenantId: 't',
        keyId: 'k',
        keyPrefix: 'p',
        scopes: options.scopes ?? ['messages:send'],
        instanceIds: [],
      },
      rateLimitPerMinute: 10,
    })),
  };
  const rateLimits = {
    consumeKey: vi.fn(
      options.rateLimit ??
        (async () => ({
          headers: { 'RateLimit-Limit': '10', 'RateLimit-Remaining': '9', 'RateLimit-Reset': '30' },
        })),
    ),
  };
  const registry = new ConnectTokenVerifierRegistry();
  const metrics = new MetricsService(env);
  const guard = new AuthGuard(
    new Reflector(),
    env,
    authenticator as unknown as ApiKeyAuthenticator,
    rateLimits as unknown as RateLimitService,
    registry,
    metrics,
  );
  return { guard, authenticator, rateLimits, registry, metrics };
}

const privateRequest = (headers: Record<string, string> = {}) => ({
  ip: '10.0.0.2',
  headers,
  routeOptions: { url: '/x' },
});

describe('AuthGuard', () => {
  it('refuses a route without a policy', async () => {
    const { guard } = build();
    await expect(guard.canActivate(context('bare', privateRequest()).ctx)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('lets a public route pass without a key', async () => {
    const { guard, authenticator } = build();
    await expect(guard.canActivate(context('open', privateRequest()).ctx)).resolves.toBe(true);
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  });

  it('authenticates a scoped route, sets request.auth, and sets the rate limit headers', async () => {
    const { guard, rateLimits } = build();
    const request = {
      ...privateRequest({ authorization: 'Bearer x' }),
      ip: '203.0.113.1',
    } as Record<string, unknown>;
    const { ctx, reply } = context('send', request);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request['auth']).toMatchObject({ tenantId: 't' });
    expect(rateLimits.consumeKey).toHaveBeenCalledWith('k', 10);
    expect(reply.header).toHaveBeenCalledWith('RateLimit-Remaining', '9');
  });

  it('needs every scope of the route (403 SCOPE_MISSING)', async () => {
    const { guard, rateLimits } = build();
    await expect(guard.canActivate(context('both', privateRequest()).ctx)).rejects.toMatchObject({
      code: 'SCOPE_MISSING',
    });
    expect(rateLimits.consumeKey).not.toHaveBeenCalled();
  });

  it('passes the 429 of the rate limit through', async () => {
    const { guard } = build({
      rateLimit: async () => Promise.reject(new AppError('RATE_LIMITED', 'x')),
    });
    await expect(guard.canActivate(context('send', privateRequest()).ctx)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('internal route: needs a private address and the shared secret, and counts each refusal', async () => {
    const { guard, metrics } = build();
    const secret = { 'x-botcenter-webhook-secret': env.EVOLUTION_WEBHOOK_SECRET };
    await expect(guard.canActivate(context('webhook', privateRequest(secret)).ctx)).resolves.toBe(
      true,
    );
    await expect(guard.canActivate(context('webhook', privateRequest()).ctx)).rejects.toMatchObject(
      { code: 'UNAUTHENTICATED' },
    );
    await expect(
      guard.canActivate(
        context('webhook', privateRequest({ 'x-botcenter-webhook-secret': 'wrong' })).ctx,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      guard.canActivate(context('webhook', { ...privateRequest(secret), ip: '203.0.113.1' }).ctx),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const refused = await metrics.internalRefusedTotal.get();
    expect(refused.values).toEqual([
      { labels: { reason: 'wrong_secret' }, value: 2 },
      { labels: { reason: 'public_address' }, value: 1 },
    ]);
  });

  it('internal route without secret (metrics): a private address is enough', async () => {
    const { guard } = build();
    await expect(guard.canActivate(context('metrics', privateRequest()).ctx)).resolves.toBe(true);
    await expect(
      guard.canActivate(context('metrics', { ...privateRequest(), ip: '8.8.8.8' }).ctx),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('connect token route: refuses without a verifier, uses the registered verifier', async () => {
    const { guard, registry } = build();
    await expect(guard.canActivate(context('events', privateRequest()).ctx)).rejects.toMatchObject({
      code: 'CONNECT_TOKEN_INVALID',
    });
    const token = { tenantId: 't', instanceId: 'i', tokenId: 'c' };
    registry.register({ verify: async () => token });
    const request = privateRequest() as Record<string, unknown>;
    await expect(guard.canActivate(context('events', request).ctx)).resolves.toBe(true);
    expect(request['connectToken']).toEqual(token);
    expect(() => registry.register({ verify: async () => token })).toThrow(/already registered/);
  });

  it('ignores a context that is not HTTP', async () => {
    const { guard } = build();
    await expect(
      guard.canActivate({ getType: () => 'rpc' } as unknown as ExecutionContext),
    ).resolves.toBe(true);
  });
});
