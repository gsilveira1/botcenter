import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { WhatsAppProvider } from '@botcenter/whatsapp-provider';
import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { Internal, Public } from '../auth/decorators';
import { getLogger } from '../logging/logger';
import { MetricsService } from '../metrics/metrics.service';
import { ApiOperation, ApiResponse } from '../openapi/openapi.decorators';
import { PrismaService } from '../prisma/prisma.service';
import { WHATSAPP_PROVIDER } from '../provider/provider.tokens';
import { REDIS } from '../redis/redis.module';

const CheckResultSchema = z.object({
  status: z.enum(['up', 'down']),
  latency_ms: z.number().int().min(0),
  /** The error class or code. Never a message with a connection string. */
  error: z.string().optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const LivenessSchema = z.object({ status: z.literal('ok') });
export const ReadinessSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.object({
    database: CheckResultSchema,
    redis: CheckResultSchema,
    provider: CheckResultSchema,
  }),
});
export type ReadinessReport = z.infer<typeof ReadinessSchema>;

const CHECK_TIMEOUT_MS = 2_000;

/** Runs one check with a time limit. */
export async function runCheck(
  check: () => Promise<unknown>,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<CheckResult> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return { status: 'up', latency_ms: Math.round(performance.now() - started) };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const name =
      error instanceof Error && error.message === 'timeout'
        ? 'timeout'
        : typeof code === 'string'
          ? code
          : error instanceof Error
            ? error.name
            : 'error';
    return { status: 'down', latency_ms: Math.round(performance.now() - started), error: name };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `GET /health/live`: the process answers (Compose restarts it otherwise).
 * `GET /health/ready`: PostgreSQL, Redis, and the provider answer. 503 when one check fails.
 * `GET /metrics`: Prometheus text, internal network only.
 */
@Controller()
export class HealthController {
  private readonly logger = getLogger('health');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    private readonly metrics: MetricsService,
  ) {}

  @Get('health/live')
  @Public()
  @ApiOperation({ summary: 'Liveness: the process answers', tags: ['health'] })
  @ApiResponse(200, {
    description: 'The process is alive',
    schema: { name: 'Liveness', schema: LivenessSchema },
  })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  @Public()
  @ApiOperation({
    summary: 'Readiness: PostgreSQL, Redis, and the WhatsApp provider answer',
    tags: ['health'],
  })
  @ApiResponse(200, {
    description: 'All checks are up',
    schema: { name: 'Readiness', schema: ReadinessSchema },
  })
  @ApiResponse(503, {
    description: 'One check is down',
    schema: { name: 'Readiness', schema: ReadinessSchema },
  })
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessReport> {
    const [database, redis, provider] = await Promise.all([
      runCheck(() => this.prisma.$queryRaw`SELECT 1`),
      runCheck(() => this.redis.ping()),
      runCheck(() => this.provider.ping()),
    ]);
    const checks = { database, redis, provider };
    const healthy = Object.values(checks).every((check) => check.status === 'up');
    if (!healthy) {
      this.logger.warn({ checks }, 'readiness check failed');
      void reply.status(503);
    }
    return { status: healthy ? 'ok' : 'unavailable', checks };
  }

  @Get('metrics')
  @Internal({ secret: false })
  async scrape(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    void reply.header('content-type', this.metrics.contentType);
    return this.metrics.render();
  }
}
