import type { CheckResult } from './run-check';
import { runCheck } from './run-check';

export interface WorkerReadinessReport {
  status: 'ok' | 'unavailable';
  checks: { database: CheckResult; redis: CheckResult };
}

/** Runs the readiness checks of the worker process. */
export type ReadinessProbe = () => Promise<WorkerReadinessReport>;

/**
 * The readiness of the worker process (ARCH-17): PostgreSQL answers `SELECT 1` and Redis answers `PING`.
 * The worker listener serves it on `GET /health/ready` and sets `botcenter_worker_ready` at each scrape.
 * The Compose health check keeps `/health/live`: a restart does not repair a dependency.
 */
export function createWorkerReadiness(
  prisma: { $queryRaw: (query: TemplateStringsArray) => PromiseLike<unknown> },
  redis: { ping: () => Promise<unknown> },
): ReadinessProbe {
  return async () => {
    const [database, redisCheck] = await Promise.all([
      runCheck(() => Promise.resolve(prisma.$queryRaw`SELECT 1`)),
      runCheck(() => redis.ping()),
    ]);
    const checks = { database, redis: redisCheck };
    const healthy = database.status === 'up' && redisCheck.status === 'up';
    return { status: healthy ? 'ok' : 'unavailable', checks };
  };
}
