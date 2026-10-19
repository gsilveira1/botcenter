import type { LoggerService } from '@nestjs/common';
import pino from 'pino';
import type { DestinationStream, Logger } from 'pino';
import { currentLogContext } from './log-context';

/**
 * JSON logs with pino. The logs never contain message content or secrets: the redact list removes the
 * fields that can carry them. Phone numbers go through `maskPhone()` before a log call.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-botcenter-webhook-secret"]',
  'headers.authorization',
  'headers["x-botcenter-webhook-secret"]',
  'authorization',
  'apiKey',
  'secret',
  'password',
  'text',
  'caption',
  'content',
  '*.authorization',
  '*.apiKey',
  '*.api_key',
  '*.secret',
  '*.secretHash',
  '*.password',
  '*.token',
  '*.text',
  '*.caption',
  '*.content',
  '*.body',
];

/** Prisma error messages can contain query arguments (personal data). Keep only safe fields. */
function serializeError(value: unknown): unknown {
  if (value instanceof Error && value.name.startsWith('PrismaClient')) {
    const error = value as Error & { code?: unknown; meta?: { modelName?: unknown } };
    return {
      type: error.name,
      code: typeof error.code === 'string' ? error.code : undefined,
      model: typeof error.meta?.modelName === 'string' ? error.meta.modelName : undefined,
    };
  }
  return value instanceof Error ? pino.stdSerializers.err(value) : value;
}

let root: Logger | undefined;

/**
 * Creates the root logger. Without a destination, pino writes to stdout asynchronously
 * (`sync: false`). Call `flushLogs()` before `process.exit`.
 */
export function createRootLogger(level: string, destination?: DestinationStream): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service: 'botcenter' },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: serializeError, error: serializeError },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    mixin: () => ({ ...currentLogContext() }),
  };
  root = pino(options, destination ?? pino.destination({ dest: 1, sync: false }));
  return root;
}

export function getLogger(module?: string): Logger {
  root ??= createRootLogger(process.env['LOG_LEVEL'] ?? 'info');
  return module ? root.child({ module }) : root;
}

/** Writes the buffered log lines. Call it before `process.exit`. */
export function flushLogs(): void {
  root?.flush();
}

/** Sends the internal messages of NestJS through pino. */
export class PinoNestLogger implements LoggerService {
  private readonly logger = getLogger('nest');

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.logger.error({ context, stack }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
