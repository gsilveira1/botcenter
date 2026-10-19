import type { Logger } from 'pino';
import { flushLogs } from '../logging/logger';

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
