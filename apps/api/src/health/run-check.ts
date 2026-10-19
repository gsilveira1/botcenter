import { z } from 'zod';

export const CheckResultSchema = z.object({
  status: z.enum(['up', 'down']),
  latency_ms: z.number().int().min(0),
  /** The error class or code. Never a message with a connection string. */
  error: z.string().optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

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
