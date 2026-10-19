import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { redisKeys } from '../redis/redis-keys';
import { REDIS } from '../redis/redis.module';
import { AlertService } from '../services/alert.service';
import type { Alert } from '../services/alert.service';

/**
 * One alert for each incident, and one recovery message. The open incidents live in one Redis hash
 * (`bc:incidents`), so two worker processes and a restart do not send the same alert again. A Redis
 * error goes to the caller (the job retries, then `WorkerFactory` alerts).
 */
@Injectable()
export class IncidentService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly alerts: AlertService,
  ) {}

  /** Opens the incident and sends the alert. Returns false when the incident was already open. */
  async raise(key: string, alert: Alert, now = new Date()): Promise<boolean> {
    const opened = await this.redis.hsetnx(redisKeys.incidents(), key, now.toISOString());
    if (opened !== 1) {
      return false;
    }
    await this.alerts.notify(alert);
    return true;
  }

  /** Closes the incident and sends the recovery message. Returns false when no incident was open. */
  async resolve(key: string, recovery: Alert): Promise<boolean> {
    const openedAt = await this.redis.hget(redisKeys.incidents(), key);
    if (openedAt === null || (await this.redis.hdel(redisKeys.incidents(), key)) !== 1) {
      return false;
    }
    await this.alerts.notify({
      ...recovery,
      details: { ...recovery.details, open_since: openedAt },
    });
    return true;
  }

  /** Raises or resolves the incident from the current value of its condition. */
  async update(
    key: string,
    failing: boolean,
    alert: Alert,
    recovery: Alert,
    now = new Date(),
  ): Promise<'opened' | 'resolved' | 'unchanged'> {
    if (failing) {
      return (await this.raise(key, alert, now)) ? 'opened' : 'unchanged';
    }
    return (await this.resolve(key, recovery)) ? 'resolved' : 'unchanged';
  }

  /** The keys of the open incidents that start with the prefix. */
  async openKeys(prefix: string): Promise<string[]> {
    const keys = await this.redis.hkeys(redisKeys.incidents());
    return keys.filter((key) => key.startsWith(prefix));
  }
}
