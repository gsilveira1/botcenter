import { SetMetadata } from '@nestjs/common';
import type { Scope } from '@botcenter/contracts';

/**
 * The access policy of a route. The global `AuthGuard` refuses a route without a policy (403), and a
 * test checks that every route of the application has one. Put the decorator on the method or the class.
 */
export type AuthPolicy =
  | { kind: 'public' }
  | { kind: 'scopes'; scopes: Scope[] }
  | { kind: 'connect_token' }
  | { kind: 'internal'; secret: boolean };

export const AUTH_POLICY = 'botcenter:auth-policy';

/** No authentication (health checks). */
export const Public = () => SetMetadata(AUTH_POLICY, { kind: 'public' } satisfies AuthPolicy);

/**
 * An API key (`Authorization: Bearer bc_live_...`) with all the given scopes. The guard puts the
 * `AuthContext` on the request (`@Auth()`), applies the rate limit of the key, and sets the
 * `RateLimit-*` headers.
 */
export const RequireScope = (...scopes: [Scope, ...Scope[]]) =>
  SetMetadata(AUTH_POLICY, { kind: 'scopes', scopes } satisfies AuthPolicy);

/**
 * A one-use connect token (the SSE route of the connect flow). The guard calls the verifier that the
 * instances slice registers in `ConnectTokenVerifierRegistry`. Without a verifier, the guard refuses.
 */
export const ConnectToken = () =>
  SetMetadata(AUTH_POLICY, { kind: 'connect_token' } satisfies AuthPolicy);

/**
 * Internal network only: the client address must be private (after the trusted proxies). With
 * `secret: true` (the default), the request must also carry the shared secret of the provider webhook
 * in the `x-botcenter-webhook-secret` header. `@Internal({ secret: false })` gives a route without the secret.
 * Internal routes are not in the OpenAPI document.
 */
export const Internal = (options: { secret?: boolean } = {}) =>
  SetMetadata(AUTH_POLICY, {
    kind: 'internal',
    secret: options.secret ?? true,
  } satisfies AuthPolicy);
