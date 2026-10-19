import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { ConnectTokenContext } from './auth-context';

/**
 * Checks the connect token of a `@ConnectToken()` route. The instances slice implements it (hash lookup,
 * `expiresAt`, one use) and throws `AppError('CONNECT_TOKEN_INVALID', ...)` for a bad token.
 */
export interface ConnectTokenVerifier {
  verify(request: FastifyRequest): Promise<ConnectTokenContext>;
}

/**
 * The extension point of `@ConnectToken()`. The instances module registers its verifier at start:
 *
 *   constructor(registry: ConnectTokenVerifierRegistry) {}
 *   onModuleInit() { this.registry.register(this); }
 */
@Injectable()
export class ConnectTokenVerifierRegistry {
  private verifier: ConnectTokenVerifier | undefined;

  register(verifier: ConnectTokenVerifier): void {
    if (this.verifier && this.verifier !== verifier) {
      throw new Error('A connect token verifier is already registered');
    }
    this.verifier = verifier;
  }

  get(): ConnectTokenVerifier | undefined {
    return this.verifier;
  }
}
