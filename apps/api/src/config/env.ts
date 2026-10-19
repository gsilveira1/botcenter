import { DEFAULT_TIMEOUTS } from '@botcenter/whatsapp-provider';
import { z } from 'zod';

/**
 * The environment of the API process and the worker process (12-factor: the configuration is in
 * environment variables). `loadEnv` validates the values at start and stops the process on an invalid
 * value (fail fast). An error message gives the names of the variables, never their values.
 */

const MIB = 1024 * 1024;

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const positiveInt = z.coerce.number().int().positive();

/** A time limit of an Evolution request: from 1 ms to 5 minutes. */
const evolutionTimeout = (fallback: number) => positiveInt.max(300_000).default(fallback);

/** A base64 text that decodes to exactly 32 bytes (an AES-256 key). */
const key32Base64 = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Must be base64')
  .refine((value) => Buffer.from(value, 'base64').length === 32, 'Must decode to 32 bytes');

const httpUrl = z.url({ protocol: /^https?$/ });

/** An empty value is the same as a missing value (Compose writes `NAME=` for an unset optional value). */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

export const ROLES = ['api', 'worker'] as const;
export type Role = (typeof ROLES)[number];

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** `api` runs the HTTP server. `worker` runs the queue workers. */
  ROLE: z.enum(ROLES).default('api'),
  PORT: positiveInt.max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Public base URL of the API. The instances slice builds `events_url` from it. */
  PUBLIC_BASE_URL: httpUrl.default('http://localhost:3000'),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_SIZE: positiveInt.max(100).default(10),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  /** Pepper of the API key hashes: `sha256(pepper + secret)`. */
  API_KEY_PEPPER: z.string().min(32, 'Must have at least 32 characters'),
  /** AES-256-GCM key (base64, 32 bytes) of `SecretBox` (webhook secrets). */
  DATA_ENCRYPTION_KEY: key32Base64,

  EVOLUTION_URL: httpUrl,
  EVOLUTION_API_KEY: z.string().min(1),
  /** Shared secret of the internal provider webhook (header `x-botcenter-webhook-secret`). */
  EVOLUTION_WEBHOOK_SECRET: z.string().min(32, 'Must have at least 32 characters'),
  /** Base URL of this API on the internal network, for the provider webhook (`http://api:3000`). */
  INTERNAL_WEBHOOK_BASE_URL: httpUrl,
  /**
   * How the Evolution adapter sends `buttons` and `list` content. `text` (default) sends a numbered text
   * menu. `native` sends the native messages, which many WhatsApp clients do not show (provider README).
   */
  EVOLUTION_INTERACTIVE_FALLBACK: z.enum(['text', 'native']).default('text'),
  /** Time limit of a state, create, logout, delete, or ping request (also the readiness ping). */
  EVOLUTION_REQUEST_TIMEOUT_MS: evolutionTimeout(DEFAULT_TIMEOUTS.requestMs),
  /** Time limit of `connect` (Evolution waits about 2 s for the first QR code). */
  EVOLUTION_CONNECT_TIMEOUT_MS: evolutionTimeout(DEFAULT_TIMEOUTS.connectMs),
  /** Time limit of one send. The adapter adds the typing delay to it. */
  EVOLUTION_SEND_TIMEOUT_MS: evolutionTimeout(DEFAULT_TIMEOUTS.sendMs),
  /** Time limit of one media download. */
  EVOLUTION_MEDIA_TIMEOUT_MS: evolutionTimeout(DEFAULT_TIMEOUTS.mediaMs),

  S3_ENDPOINT: httpUrl,
  S3_REGION: z.string().min(1).default('auto'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanString.default(false),

  /** Discord webhook of the operations channel. Without it, `AlertService` logs the alert at `error`. */
  ALERT_DISCORD_WEBHOOK_URL: optional(z.url({ protocol: /^https$/ })),

  /**
   * Proxies that Fastify trusts for `X-Forwarded-For` (`proxy-addr` syntax). The default trusts only
   * private addresses (Caddy on the Docker network), so `request.ip` is the first public address.
   */
  TRUST_PROXY: z.string().min(1).default('loopback,linklocal,uniquelocal'),
  /** Maximum JSON body of a request. Routes in `ROUTE_BODY_LIMITS` can have more. */
  BODY_LIMIT_BYTES: positiveInt.default(MIB),
  /** Maximum body of `POST /internal/evolution/webhook`. */
  INTERNAL_WEBHOOK_BODY_LIMIT_BYTES: positiveInt.default(8 * MIB),
  /** Keep-alive time of an idle HTTP connection. Keep it above the idle time of Caddy. */
  KEEP_ALIVE_TIMEOUT_MS: positiveInt.default(65_000),
  /** Maximum time of a graceful shutdown (current requests and jobs). */
  SHUTDOWN_TIMEOUT_MS: positiveInt.default(25_000),

  /** Internal HTTP listener of the worker process (`/metrics`, `/health/live`). */
  WORKER_METRICS_PORT: positiveInt.max(65535).default(9464),
  WORKER_CONCURRENCY_OUTBOUND: positiveInt.max(200).default(10),
  WORKER_CONCURRENCY_INBOUND: positiveInt.max(200).default(10),
  WORKER_CONCURRENCY_WEBHOOKS: positiveInt.max(200).default(10),
  WORKER_CONCURRENCY_TIMERS: positiveInt.max(200).default(5),
  WORKER_CONCURRENCY_MAINTENANCE: positiveInt.max(10).default(1),
});

export type AppEnv = z.infer<typeof EnvSchema>;

/** DI token of the validated environment. */
export const ENV = Symbol('ENV');

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
    this.name = 'EnvError';
  }
}

/** Validates the environment. Throws `EnvError` with the name and the problem of each bad variable. */
export function loadEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): AppEnv {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

export function isProduction(env: AppEnv): boolean {
  return env.NODE_ENV === 'production';
}
