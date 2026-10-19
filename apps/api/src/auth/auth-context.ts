import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Scope } from '@botcenter/contracts';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../common/errors/app-error';
import { bindLogContext } from '../logging/log-context';
import type { LogContext } from '../logging/log-context';

/** The caller of a route with `@RequireScope(...)`. */
export interface AuthContext {
  tenantId: string;
  keyId: string;
  /** Public part of the key. The audit actor is `api_key:<keyPrefix>`. */
  keyPrefix: string;
  scopes: Scope[];
  /** Instances that the key can use. An empty list means all the instances of the tenant. */
  instanceIds: string[];
}

/** The caller of a route with `@ConnectToken()`. The instances slice fills it. */
export interface ConnectTokenContext {
  tenantId: string;
  instanceId: string;
  tokenId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    connectToken?: ConnectTokenContext;
    /** The log fields of the request (`request_id`, `tenant_id`, `instance_id`). */
    logContext?: LogContext;
  }
}

export function auditActor(auth: Pick<AuthContext, 'keyPrefix'>): string {
  return `api_key:${auth.keyPrefix}`;
}

/**
 * Refuses an instance that the key cannot use (403 `INSTANCE_NOT_ALLOWED`) and adds `instance_id` to
 * the log context. Call it before each action on an instance. It does not check the tenant: the
 * repository query with `tenantId` does that.
 */
export function assertInstanceAllowed(auth: AuthContext, instanceId: string): void {
  if (auth.instanceIds.length > 0 && !auth.instanceIds.includes(instanceId)) {
    throw new AppError('INSTANCE_NOT_ALLOWED', 'The API key cannot use this instance');
  }
  bindLogContext({ instance_id: instanceId });
}

/** True when the key can use every instance of the tenant. */
export function allowsAllInstances(auth: AuthContext): boolean {
  return auth.instanceIds.length === 0;
}

/**
 * Refuses a key with an instance list (403 `INSTANCE_NOT_ALLOWED`) on a route that acts for the full
 * tenant, for example `/v1/webhooks`: the events of every instance go to the webhooks (SEC-03).
 */
export function assertAllInstancesAllowed(auth: AuthContext, action: string): void {
  if (!allowsAllInstances(auth)) {
    throw new AppError(
      'INSTANCE_NOT_ALLOWED',
      `An API key with an instance list cannot ${action}: it applies to every instance of the tenant`,
    );
  }
}

/** Route parameter: the `AuthContext` of the request. Use it only on `@RequireScope(...)` routes. */
export const Auth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!request.auth) {
      // A programming error: the route has no `@RequireScope(...)`.
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    return request.auth;
  },
);

/** Route parameter: the `ConnectTokenContext` of a `@ConnectToken()` route. */
export const ConnectTokenAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ConnectTokenContext => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!request.connectToken) {
      throw new AppError('CONNECT_TOKEN_INVALID', 'Connect token required');
    }
    return request.connectToken;
  },
);
