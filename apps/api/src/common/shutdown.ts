import type { Logger } from 'pino';
import type { AppEnv } from '../config/env';
import { flushLogs } from '../logging/logger';

/** The longest typing delay of a bot reply (`TYPING_DELAY.maxMs` of the conversations slice). */
export const MAX_TYPING_DELAY_MS = 4_000;
/**
 * The bot HTTP time of one conversation step: the `external` condition (at most 5 s) and one
 * `call_webhook` action (5 s, one more attempt). A step with more `call_webhook` actions can take longer.
 */
export const BOT_STEP_HTTP_BUDGET_MS = 5_000 + 2 * 5_000;
/** The time after the longest job for the close of the queues, Redis, and PostgreSQL. */
export const SHUTDOWN_MARGIN_MS = 5_000;

/**
 * The longest job of the worker process with side effects outside Bot Center (ARCH-11):
 * - an outbound send: the download of a media `url`, the bucket write, the send with the typing delay,
 *   and the state read after a failed send;
 * - an inbound message: the media download from the provider, the bucket write, and the bot step.
 * The maintenance jobs are idempotent: a stop can cut them, and the next run continues.
 */
export function longestWorkerJobMs(env: AppEnv): number {
  const outbound =
    env.OUTBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS +
    env.S3_REQUEST_TIMEOUT_MS +
    env.EVOLUTION_SEND_TIMEOUT_MS +
    MAX_TYPING_DELAY_MS +
    env.EVOLUTION_REQUEST_TIMEOUT_MS;
  const inbound =
    env.EVOLUTION_MEDIA_TIMEOUT_MS + env.S3_REQUEST_TIMEOUT_MS + BOT_STEP_HTTP_BUDGET_MS;
  return Math.max(outbound, inbound);
}

/**
 * Stops the start of the worker when `WORKER_SHUTDOWN_TIMEOUT_MS` is shorter than the longest job plus
 * the margin. Else a deploy can stop a send in progress, and the next worker sends the message again.
 */
export function assertWorkerShutdownBudget(env: AppEnv): void {
  const needed = longestWorkerJobMs(env) + SHUTDOWN_MARGIN_MS;
  if (env.WORKER_SHUTDOWN_TIMEOUT_MS < needed) {
    throw new Error(
      `WORKER_SHUTDOWN_TIMEOUT_MS (${env.WORKER_SHUTDOWN_TIMEOUT_MS} ms) must be at least ${needed} ms: ` +
        'the longest job and the close of the connections. Increase it (and the container stop time), ' +
        'or decrease the time limits of the jobs.',
    );
  }
}

export interface ShutdownOptions {
  /** Stops the process work: the HTTP server, the workers, the queues, and the connections. */
  close: () => Promise<void>;
  timeoutMs: number;
  logger: Logger;
  exit?: (code: number) => void;
}

/**
 * Returns the signal handler of a graceful shutdown. The first signal starts `close()`. If `close()`
 * fails or takes more than `timeoutMs`, the exit code is 1 (the jobs that still run go back to the queue
 * when their BullMQ lock ends). A second signal during the shutdown does nothing.
 */
export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;
  return async (signal) => {
    if (started) {
      return;
    }
    started = true;
    options.logger.info({ signal }, 'shutdown started');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), options.timeoutMs);
    });
    let code = 0;
    try {
      const result = await Promise.race([options.close().then(() => 'closed' as const), timeout]);
      if (result === 'timeout') {
        options.logger.error({ timeout_ms: options.timeoutMs }, 'shutdown timed out');
        code = 1;
      } else {
        options.logger.info('shutdown complete');
      }
    } catch (error) {
      options.logger.error({ err: error }, 'shutdown failed');
      code = 1;
    } finally {
      clearTimeout(timer);
    }
    flushLogs();
    exit(code);
  };
}
