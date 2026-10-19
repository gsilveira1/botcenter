import 'reflect-metadata';
import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { AppModule } from './app.module';
import { REQUEST_ID_HEADER, generateRequestId } from './common/http/request-id';
import { ENV, isProduction, loadEnv } from './config/env';
import type { AppEnv } from './config/env';
import { INTERNAL_WEBHOOK_PATH } from './inbound/internal-webhook.controller';
import { runWithLogContext } from './logging/log-context';
import { PinoNestLogger } from './logging/logger';
import { MetricsService } from './metrics/metrics.service';

/**
 * The Fastify settings of the API (plan, section 17 of the api-core scope):
 * - `bodyLimit`: 1 MiB (`BODY_LIMIT_BYTES`); the routes in `routeBodyLimits` can have more.
 * - `trustProxy`: only private addresses (Caddy on the Docker network), so `request.ip` is the first
 *   public address of `X-Forwarded-For` and a client cannot spoof a private address.
 * - `keepAliveTimeout` above the idle time of Caddy; `return503OnClosing` during a shutdown.
 * - `X-Request-Id`: the safe value of the caller, or a new UUID.
 */
export function createFastifyAdapter(env: AppEnv): FastifyAdapter {
  return new FastifyAdapter({
    bodyLimit: env.BODY_LIMIT_BYTES,
    trustProxy: env.TRUST_PROXY,
    keepAliveTimeout: env.KEEP_ALIVE_TIMEOUT_MS,
    requestTimeout: 30_000,
    genReqId: generateRequestId,
    requestIdHeader: false,
    logger: false,
    return503OnClosing: true,
    forceCloseConnections: 'idle',
  });
}

/** Routes with a body limit above `BODY_LIMIT_BYTES` (`METHOD path` to bytes). */
export function routeBodyLimits(env: AppEnv): Record<string, number> {
  return { [`POST ${INTERNAL_WEBHOOK_PATH}`]: env.INTERNAL_WEBHOOK_BODY_LIMIT_BYTES };
}

/**
 * Applies the HTTP pipeline to a created application, before `init()` or `listen()`.
 * The tests call it on a testing module.
 */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  const env = app.get<AppEnv>(ENV);
  const metrics = app.get(MetricsService);
  const fastify = app.getHttpAdapter().getInstance();
  const limits = routeBodyLimits(env);

  fastify.addHook('onRoute', (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const limit = limits[`${method} ${route.url}`];
      if (limit !== undefined) {
        route.bodyLimit = limit;
      }
    }
  });

  // JSON only: Fastify keeps its `application/json` parser; a different body type gets 415.
  fastify.removeContentTypeParser(['text/plain']);

  fastify.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    request.logContext = { request_id: request.id };
    void reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });

  // The Nest handler (guards, pipes, interceptors, controller) runs inside this context, so each log
  // line of the request has `request_id` (and `tenant_id` after the guard).
  fastify.addHook(
    'preHandler',
    (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
      runWithLogContext(request.logContext ?? { request_id: request.id }, done);
    },
  );

  fastify.addHook(
    'onResponse',
    (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
      metrics.httpRequestDuration.observe(
        {
          method: request.method,
          route: request.routeOptions.url ?? 'unmatched',
          status_code: String(reply.statusCode),
        },
        reply.elapsedTime / 1000,
      );
      done();
    },
  );

  await app.register(helmet as never, {
    // The API returns JSON only: no script, no frame, no content of other origins.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: isProduction(env) ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });

  // No `enableShutdownHooks()`: `main.ts` owns the signals. The Nest hook sends the signal again after
  // `close()`, and the process then ends with code 143 before the shutdown completes.
}

/** Creates the API application (not listening). `main.ts` and the OpenAPI export use it. */
export async function createApiApp(): Promise<NestFastifyApplication> {
  const env = loadEnv();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createFastifyAdapter(env),
    {
      logger: new PinoNestLogger(),
      abortOnError: false,
      bodyParser: false,
    },
  );
  await configureApp(app);
  return app;
}
