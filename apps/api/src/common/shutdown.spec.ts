import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from './shutdown';

const logger = pino({ level: 'silent' });

describe('createShutdown', () => {
  it('closes once and exits with 0', async () => {
    const close = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = createShutdown({ close, timeoutMs: 1000, logger, exit });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits with 1 on a failure or a timeout', async () => {
    const exit = vi.fn();
    await createShutdown({
      close: async () => Promise.reject(new Error('x')),
      timeoutMs: 1000,
      logger,
      exit,
    })('SIGTERM');
    await createShutdown({
      close: () => new Promise(() => undefined),
      timeoutMs: 10,
      logger,
      exit,
    })('SIGTERM');
    expect(exit.mock.calls).toEqual([[1], [1]]);
  });
});
