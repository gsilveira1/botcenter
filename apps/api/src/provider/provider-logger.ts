import type { ProviderLogger } from '@botcenter/whatsapp-provider';
import type { Logger } from 'pino';

/**
 * Sends the log lines of `@botcenter/whatsapp-provider` through the pino logger of the process, so they
 * get the redact list, the log context (`request_id`, `tenant_id`, `instance_id`), and the level.
 */
export function pinoProviderLogger(logger: Logger): ProviderLogger {
  return {
    debug: (fields, message) => logger.debug(fields, message),
    info: (fields, message) => logger.info(fields, message),
    warn: (fields, message) => logger.warn(fields, message),
    error: (fields, message) => logger.error(fields, message),
  };
}
