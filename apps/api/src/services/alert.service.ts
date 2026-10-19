import { Inject, Injectable, Optional } from '@nestjs/common';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { getLogger } from '../logging/logger';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  severity: AlertSeverity;
  title: string;
  /** Short technical facts (ids, codes, counts). Never message content, secrets, or full phone numbers. */
  details?: Record<string, string | number | boolean | null | undefined>;
  /**
   * Alerts with the same key are sent once in the dedupe window (5 min). The log line is always written.
   * Use it for an error that can repeat on each request or job.
   */
  dedupeKey?: string;
}

/** Function that posts JSON. Tests replace it. */
export type HttpPost = (url: string, body: unknown, timeoutMs: number) => Promise<number>;

export const ALERT_HTTP_POST = Symbol('ALERT_HTTP_POST');

const DEDUPE_WINDOW_MS = 5 * 60_000;
const DEDUPE_MAX_KEYS = 1_000;
const DISCORD_TIMEOUT_MS = 5_000;
const COLORS: Record<AlertSeverity, number> = {
  info: 0x3b82f6,
  warning: 0xf59e0b,
  critical: 0xdc2626,
};

export const defaultHttpPost: HttpPost = async (url, body, timeoutMs) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response.status;
};

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Sends operational alerts to the Discord channel of the operators (`ALERT_DISCORD_WEBHOOK_URL`).
 * `notify` never throws: when the URL is missing or Discord fails, it logs the alert at `error` and the
 * caller continues.
 */
@Injectable()
export class AlertService {
  private readonly logger = getLogger('alert');
  private readonly lastSent = new Map<string, number>();
  private readonly post: HttpPost;

  constructor(
    @Inject(ENV) private readonly env: AppEnv,
    @Optional() @Inject(ALERT_HTTP_POST) post?: HttpPost,
  ) {
    this.post = post ?? defaultHttpPost;
  }

  async notify(alert: Alert, now = Date.now()): Promise<void> {
    const fields = { severity: alert.severity, title: alert.title, details: alert.details };
    if (alert.dedupeKey && this.isDuplicate(alert.dedupeKey, now)) {
      this.logger.warn(fields, 'alert suppressed (same alert in the dedupe window)');
      return;
    }
    const url = this.env.ALERT_DISCORD_WEBHOOK_URL;
    if (!url) {
      this.logger.error(fields, 'alert (ALERT_DISCORD_WEBHOOK_URL is not set)');
      return;
    }
    try {
      const status = await this.post(url, this.toDiscord(alert, now), DISCORD_TIMEOUT_MS);
      if (status < 200 || status >= 300) {
        this.logger.error({ ...fields, discord_status: status }, 'alert not delivered to Discord');
        return;
      }
      this.logger.warn(fields, 'alert sent');
    } catch (error) {
      this.logger.error({ ...fields, err: error }, 'alert not delivered to Discord');
    }
  }

  private isDuplicate(key: string, now: number): boolean {
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
      return true;
    }
    if (this.lastSent.size >= DEDUPE_MAX_KEYS) {
      this.lastSent.clear();
    }
    this.lastSent.set(key, now);
    return false;
  }

  private toDiscord(alert: Alert, now: number): unknown {
    const fields = Object.entries(alert.details ?? {})
      .filter(([, value]) => value !== undefined)
      .slice(0, 25)
      .map(([name, value]) => ({
        name: truncate(name, 256),
        value: truncate(String(value), 1024),
        inline: true,
      }));
    return {
      username: 'Bot Center',
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: truncate(`[${alert.severity}] ${alert.title}`, 256),
          color: COLORS[alert.severity],
          fields,
          footer: { text: `env: ${this.env.NODE_ENV}, role: ${this.env.ROLE}` },
          timestamp: new Date(now).toISOString(),
        },
      ],
    };
  }
}
