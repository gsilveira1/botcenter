import { Injectable, SetMetadata } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { catchError, concatMap, from, of, switchMap, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { validationError } from '../common/errors/app-error';
import { getLogger } from '../logging/logger';
import { AlertService } from '../services/alert.service';
import { IdempotencyService, requestHash } from './idempotency.service';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;
const METHODS = new Set(['POST', 'PUT', 'DELETE']);
/** Metadata key of `@SkipIdempotency()`. The OpenAPI generator reads it too. */
export const SKIP_IDEMPOTENCY = 'botcenter:skip-idempotency';

/** The route ignores `Idempotency-Key` (for example, a response with a secret that must not be stored). */
export const SkipIdempotency = () => SetMetadata(SKIP_IDEMPOTENCY, true);

/**
 * `Idempotency-Key` for `POST`, `PUT`, and `DELETE` under `/v1` (plan, section 4). The header is optional.
 * With the header, the first request runs and its status and body are stored for 24 h. A repeat with the
 * same request gets the stored response with `Idempotency-Replayed: true`. A failed request (an error)
 * frees the key. The scope is the tenant and the API key (SEC-09): the stored key is
 * `<api key id>:<Idempotency-Key>`, so a replay never skips the checks of an other key of the tenant
 * (for example its instance list). The interceptor needs `request.auth`.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = getLogger('idempotency');

  constructor(
    private readonly store: IdempotencyService,
    private readonly reflector: Reflector,
    private readonly alerts: AlertService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const header = request.headers[IDEMPOTENCY_HEADER];
    const rawKey = Array.isArray(header) ? header[0] : header;
    if (
      rawKey === undefined ||
      !METHODS.has(request.method) ||
      !request.url.startsWith('/v1/') ||
      !request.auth ||
      this.reflector.getAllAndOverride<boolean | undefined>(SKIP_IDEMPOTENCY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return next.handle();
    }
    if (!KEY_PATTERN.test(rawKey)) {
      throw validationError('The Idempotency-Key header is not valid', [
        { path: 'Idempotency-Key', message: 'Must be 1 to 255 visible ASCII characters' },
      ]);
    }
    const tenantId = request.auth.tenantId;
    const scopedKey = `${request.auth.keyId}:${rawKey}`;
    const hash = requestHash(request.method, request.url, request.body);

    return from(this.store.start(tenantId, scopedKey, hash)).pipe(
      switchMap((start) => {
        if (start.kind === 'replay') {
          void reply.status(start.status).header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
          return of(start.body);
        }
        return next.handle().pipe(
          concatMap(async (body: unknown) => {
            await this.complete(tenantId, start.id, reply.statusCode, body);
            void reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'false');
            return body;
          }),
          catchError((error: unknown) =>
            from(this.abandon(tenantId, start.id)).pipe(switchMap(() => throwError(() => error))),
          ),
        );
      }),
    );
  }

  /** The action succeeded. A store error does not change the response; it is logged and alerted. */
  private async complete(
    tenantId: string,
    id: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    try {
      await this.store.complete(tenantId, id, status, body);
    } catch (error) {
      this.logger.error(
        { err: error },
        'idempotency response not stored; a retry can run the action again after the lock time',
      );
      void this.alerts.notify({
        severity: 'warning',
        title: 'Idempotency response not stored',
        dedupeKey: 'idempotency:complete',
      });
    }
  }

  private async abandon(tenantId: string, id: string): Promise<void> {
    try {
      await this.store.abandon(tenantId, id);
    } catch (error) {
      this.logger.error(
        { err: error },
        'idempotency key not freed; it stays locked until the lock time ends',
      );
    }
  }
}
