/**
 * A processor throws this error when the job cannot run now but is not a failure (for example, the lock
 * of a conversation is busy). `WorkerFactory` moves the job back to the delayed set for `delayMs`. The
 * attempt count does not change, no failure is logged, and the result metric is `delayed`.
 */
export class RetryLaterError extends Error {
  constructor(
    readonly delayMs: number,
    readonly reason: string,
  ) {
    super(`Retry the job later (${reason})`);
    this.name = 'RetryLaterError';
  }
}
