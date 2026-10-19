import { setTimeout as sleep } from 'node:timers/promises';

/** Polls `check` every 50 ms until it returns true. Throws when the time limit ends. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await sleep(50);
  }
}
