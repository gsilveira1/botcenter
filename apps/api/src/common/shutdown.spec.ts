import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { EXTERNAL_TIMEOUT_MS_MAX } from '@botcenter/contracts';
import { testEnv } from '../../test/support/env';
import { TYPING_DELAY } from '../conversations/typing-delay';
import { BOT_WEBHOOK_TIMEOUT_MS } from '../conversations/worker/bot-http';
import {
  BOT_STEP_HTTP_BUDGET_MS,
  MAX_TYPING_DELAY_MS,
  SHUTDOWN_MARGIN_MS,
  assertWorkerShutdownBudget,
  createShutdown,
  longestWorkerJobMs,
} from './shutdown';

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

describe('worker shutdown budget (ARCH-11)', () => {
  it('lets the longest job end before the shutdown time with the default values', () => {
    const env = testEnv({ ROLE: 'worker' });
    // Outbound: media download 20 s + bucket 15 s + send 30 s + typing 4 s + state read 10 s = 79 s.
    // Inbound: media download 60 s + bucket 15 s + external condition 5 s + call_webhook 2 x 5 s = 90 s.
    expect(longestWorkerJobMs(env)).toBe(90_000);
    expect(env.WORKER_SHUTDOWN_TIMEOUT_MS).toBeGreaterThanOrEqual(
      longestWorkerJobMs(env) + SHUTDOWN_MARGIN_MS,
    );
    expect(() => assertWorkerShutdownBudget(env)).not.toThrow();
  });

  it('refuses a shutdown time that is shorter than the longest job', () => {
    expect(() =>
      assertWorkerShutdownBudget(testEnv({ ROLE: 'worker', WORKER_SHUTDOWN_TIMEOUT_MS: '25000' })),
    ).toThrow(/WORKER_SHUTDOWN_TIMEOUT_MS \(25000 ms\) must be at least 95000 ms/);
    expect(() =>
      assertWorkerShutdownBudget(testEnv({ ROLE: 'worker', EVOLUTION_SEND_TIMEOUT_MS: '120000' })),
    ).toThrow(/WORKER_SHUTDOWN_TIMEOUT_MS/);
  });

  it('uses the limits of the other slices', () => {
    expect(MAX_TYPING_DELAY_MS).toBe(TYPING_DELAY.maxMs);
    expect(BOT_STEP_HTTP_BUDGET_MS).toBe(EXTERNAL_TIMEOUT_MS_MAX + 2 * BOT_WEBHOOK_TIMEOUT_MS);
  });
});
