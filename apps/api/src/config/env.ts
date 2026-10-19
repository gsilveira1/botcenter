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

/**
 * A comma list of browser origins (`https://app.example.com`). An empty value is an empty list. Each
 * item must be an origin: a scheme, a host, and an optional port, with no path.
 */
const originList = z
  .string()
  .default('')
  .transform((value, context) => {
    const items = value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    for (const item of items) {
      if (!URL.canParse(item) || new URL(item).origin !== item) {
        context.addIssue({ code: 'custom', message: 'Each item must be an origin with no path' });
        return z.NEVER;
      }
    }
    return items;
  });

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
  /**
   * Browser origins that can open the connect event stream (`GET /v1/connect/{token}/events`). Only this
   * route sends CORS headers. Empty (the default): no CORS header.
   */
  CONNECT_ALLOWED_ORIGINS: originList,

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
  /** Time limit of one object storage request (the worker shutdown budget counts it). */
  S3_REQUEST_TIMEOUT_MS: positiveInt.max(120_000).default(15_000),

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
  /** Maximum time of a graceful shutdown of the API process (current requests). */
  SHUTDOWN_TIMEOUT_MS: positiveInt.default(25_000),
  /**
   * Maximum time of a graceful shutdown of the worker process (ARCH-11). It must be longer than the
   * longest job (`longestWorkerJobMs` in `common/shutdown.ts`), or the worker does not start. The
   * container stop time (Compose `stop_grace_period`) must be longer again: 110 s for the default.
   */
  WORKER_SHUTDOWN_TIMEOUT_MS: positiveInt.max(600_000).default(100_000),

  /** Internal HTTP listener of the worker process (`/metrics`, `/health/live`). */
  WORKER_METRICS_PORT: positiveInt.max(65535).default(9464),
  WORKER_CONCURRENCY_OUTBOUND: positiveInt.max(200).default(10),
  WORKER_CONCURRENCY_INBOUND: positiveInt.max(200).default(10),
  WORKER_CONCURRENCY_WEBHOOKS: positiveInt.max(200).default(10),
  WORKER_CONCURRENCY_TIMERS: positiveInt.max(200).default(5),
  WORKER_CONCURRENCY_MAINTENANCE: positiveInt.max(10).default(1),
  WORKER_CONCURRENCY_INSTANCES: positiveInt.max(10).default(1),

  /** Size (burst) of the send token bucket of each instance. The rate is `instances.rateLimitPerMinute`. */
  OUTBOUND_BUCKET_BURST: positiveInt.max(60).default(3),
  /** Warm-up of a new number: the days from the first connection to the full send rate. `0` or `1` turns it off. */
  OUTBOUND_WARMUP_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  /** Warm-up: the send rate on the first day, in percent of the full rate. The rate grows linearly. */
  OUTBOUND_WARMUP_START_PERCENT: positiveInt.max(100).default(20),
  /**
   * Maximum `queued` outbound rows of one instance (SEC-04). Above it, `POST /v1/messages` answers 429
   * `QUOTA_EXCEEDED` and a new bot reply is written as `failed` (`instance_queue_full`).
   */
  OUTBOUND_MAX_QUEUED_PER_INSTANCE: positiveInt.max(1_000_000).default(1_000),
  /**
   * Maximum age of a `queued` outbound row. The outbound sweep writes an older row as `failed`
   * (`expired`), with the `message.status` event. Default: 24 h.
   */
  OUTBOUND_QUEUED_MAX_AGE_SECONDS: positiveInt
    .min(600)
    .max(30 * 86_400)
    .default(86_400),
  /**
   * Validity of the pre-signed upload URL of `POST /v1/media`. The URL can be used again while it is
   * valid, so it is short (SEC-17).
   */
  MEDIA_UPLOAD_URL_TTL_SECONDS: positiveInt.max(3_600).default(300),
  /** Validity of the signed download URL of `GET /v1/media/{id}`. */
  MEDIA_READ_URL_TTL_SECONDS: positiveInt.max(86_400).default(900),
  /** Maximum `POST /v1/media` calls of one tenant in one UTC day (SEC-17). */
  MEDIA_UPLOADS_PER_DAY: positiveInt.max(1_000_000).default(1_000),
  /** Maximum sum of the declared sizes of the live outbound media of one tenant (SEC-17). Default 5 GiB. */
  MEDIA_MAX_BYTES_PER_TENANT: positiveInt.default(5 * 1024 * MIB),
  /** Validity of the pre-signed download URL that the provider gets for a media message. */
  MEDIA_SEND_URL_TTL_SECONDS: positiveInt.max(86_400).default(900),
  /**
   * Time limit of the download of a client media `url` by the outbound worker (SEC-01). The worker stores
   * the file in the bucket and gives the provider a pre-signed URL. At most 30 s (the external HTTP limit).
   */
  OUTBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS: positiveInt.max(30_000).default(20_000),

  /**
   * Test and development only: the SSRF guard of the external HTTP client accepts private, loopback, and
   * link-local addresses. `loadEnv` refuses `true` when `NODE_ENV=production`.
   */
  EXTERNAL_HTTP_ALLOW_PRIVATE: booleanString.default(false),
  /** Maximum response body of an external HTTP call (the `external` condition of the engine). */
  EXTERNAL_HTTP_MAX_RESPONSE_BYTES: positiveInt.max(16 * MIB).default(MIB),
  /** Pause of the outbox dispatcher of the worker when no event waits. */
  OUTBOX_DISPATCH_INTERVAL_MS: positiveInt.max(60_000).default(1_000),
});

/** Rules between variables. A schema refinement would hide the object shape, so `loadEnv` applies them. */
function crossChecks(env: z.infer<typeof EnvSchema>): string[] {
  return env.NODE_ENV === 'production' && env.EXTERNAL_HTTP_ALLOW_PRIVATE
    ? ['EXTERNAL_HTTP_ALLOW_PRIVATE: Must be false when NODE_ENV is production']
    : [];
}

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
  const problems = crossChecks(result.data);
  if (problems.length > 0) {
    throw new EnvError(problems);
  }
  return result.data;
}

export function isProduction(env: AppEnv): boolean {
  return env.NODE_ENV === 'production';
}
