import { Catch, Injectable } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getLogger } from '../../logging/logger';
import { AlertService } from '../../services/alert.service';
import { PROBLEM_CONTENT_TYPE, toProblem } from './problem';

/**
 * Global exception filter: every error response is `application/problem+json` (RFC 9457).
 * An unexpected error (5xx) is logged with the stack and goes to `AlertService` (one alert for each
 * route and status in the dedupe window). A 4xx is logged at `info` or `warn` without the stack.
 */
@Catch()
@Injectable()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = getLogger('http');

  constructor(private readonly alerts: AlertService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = toProblem(exception, { id: request.id, url: request.url });
    const route = request.routeOptions?.url ?? 'unmatched';
    const fields = {
      request_id: request.id,
      method: request.method,
      route,
      status: problem.status,
      code: problem.body.code,
    };

    if (problem.unexpected) {
      this.logger.error({ ...fields, err: exception }, 'request failed');
      void this.alerts.notify({
        severity: 'critical',
        title: `HTTP ${problem.status} on ${request.method} ${route}`,
        details: { code: problem.body.code, request_id: request.id },
        dedupeKey: `http:${request.method}:${route}:${problem.status}`,
      });
    } else if ([401, 403, 429].includes(problem.status)) {
      this.logger.warn(fields, 'request refused');
    } else {
      this.logger.info(fields, 'request refused');
    }

    if (reply.sent) {
      return;
    }
    for (const [name, value] of Object.entries(problem.headers)) {
      void reply.header(name, value);
    }
    void reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem.body);
  }
}
