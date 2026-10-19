/**
 * Structural logger interface of the provider package. A pino logger matches it
 * (`logger.warn({ ... }, 'message')`), so the package does not depend on pino.
 * Never put message content, phone numbers, or secrets in the fields.
 */
export interface ProviderLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** The default logger: it writes warnings and errors to stderr and drops the other levels. */
export const consoleWarnLogger: ProviderLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (fields, message) => console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
  error: (fields, message) => console.error(JSON.stringify({ level: 'error', message, ...fields })),
};

/** Replaces each run of 8 or more digits (a phone number or a JID) with a masked value. */
export function maskDigits(text: string): string {
  return text.replace(/\d{8,}/g, (digits) => `${digits.slice(0, 4)}*****${digits.slice(-4)}`);
}
