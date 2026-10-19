import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The fields that each log line of a request or a job carries. The logger reads them from an
 * `AsyncLocalStorage`, so a service does not pass them by hand. The names are the names in the JSON logs.
 */
export interface LogContext {
  request_id?: string;
  tenant_id?: string;
  instance_id?: string;
  queue?: string;
  job_id?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with `context`. The context object stays mutable: `bindLogContext` adds fields to it. */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}

/**
 * Adds fields to the current context (for example `tenant_id` after the authentication).
 * Outside a context, the call does nothing: a log line without these fields is still correct.
 */
export function bindLogContext(fields: Partial<LogContext>): void {
  const store = storage.getStore();
  if (!store) {
    return;
  }
  for (const [key, value] of Object.entries(fields) as [keyof LogContext, string | undefined][]) {
    if (value !== undefined) {
      store[key] = value;
    }
  }
}
