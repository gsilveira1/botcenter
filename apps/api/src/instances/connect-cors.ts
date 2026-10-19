import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';

/** The Fastify route of the connect event stream. */
export const CONNECT_EVENTS_ROUTE = '/v1/connect/:token/events';

/**
 * The CORS headers of the connect stream. A browser opens the stream with `EventSource` (a simple GET
 * request, no preflight), so the response needs `Access-Control-Allow-Origin` for an allowed origin.
 * An empty list sends no CORS header. No credentials: the token in the URL is the authorization.
 */
export function connectCorsHeaders(
  origin: string | undefined,
  allowed: readonly string[],
): Record<string, string> {
  if (allowed.length === 0) {
    return {};
  }
  if (origin && allowed.includes(origin)) {
    return { 'access-control-allow-origin': origin, vary: 'Origin' };
  }
  return { vary: 'Origin' };
}

/**
 * Adds the CORS headers to every answer of the connect stream route, also to the 401 of the guard.
 * The other routes of the API send no CORS header.
 */
@Injectable()
export class ConnectCorsHook implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  onModuleInit(): void {
    // A testing module without an HTTP adapter (an application context) has no Fastify instance.
    const fastify = this.adapterHost.httpAdapter?.getInstance<FastifyInstance>();
    if (!fastify || typeof fastify.addHook !== 'function') {
      return;
    }
    const allowed = this.env.CONNECT_ALLOWED_ORIGINS;
    fastify.addHook(
      'onRequest',
      (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
        if (request.routeOptions.url === CONNECT_EVENTS_ROUTE) {
          void reply.headers(connectCorsHeaders(request.headers.origin, allowed));
        }
        done();
      },
    );
  }
}
