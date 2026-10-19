// Pure configuration of the k6 scenarios: no k6 module, so `node --test` can check it.
// Each value comes from the environment (`k6 run -e NAME=value`, or `__ENV` in k6).

/** Thresholds of the architecture: p95 below 150 ms for the 202 answer, errors below 1 %. */
export const SEND_P95_MS = 150;
export const STATUS_P95_MS = 100;
export const MAX_ERROR_RATE = 0.01;

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {string}
 */
export function requireEnv(env, name) {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required (k6 run -e ${name}=...)`);
  }
  return value;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export function positiveNumber(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number (value: ${raw})`);
  }
  return value;
}

/**
 * Constant arrival rate: k6 starts RATE requests per second for DURATION, independent of the
 * latency. A slow API then shows as a higher latency and more VUs, not as a lower request rate.
 * @param {Record<string, string | undefined>} env
 * @param {string} requestName The `name` tag of the measured request.
 * @param {number} p95Ms
 */
export function buildOptions(env, requestName, p95Ms) {
  const rate = positiveNumber(env, 'RATE', 50);
  const preAllocatedVUs = positiveNumber(env, 'VUS', Math.max(10, Math.ceil(rate / 5)));
  return {
    scenarios: {
      steady: {
        executor: 'constant-arrival-rate',
        rate,
        timeUnit: '1s',
        duration: env.DURATION || '2m',
        preAllocatedVUs,
        maxVUs: positiveNumber(env, 'MAX_VUS', preAllocatedVUs * 4),
      },
    },
    thresholds: {
      [`http_req_duration{name:${requestName},expected_response:true}`]: [`p(95)<${p95Ms}`],
      http_req_failed: [`rate<${MAX_ERROR_RATE}`],
      checks: [`rate>${1 - MAX_ERROR_RATE}`],
    },
    // The answer bodies are small; k6 keeps them only for the checks.
    discardResponseBodies: false,
    summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  };
}

export const SEND_REQUEST_NAME = 'POST /v1/messages';
export const STATUS_REQUEST_NAME = 'GET /v1/messages/{id}';

/**
 * The instance of one request. `INSTANCE_IDS` (a comma list) spreads the messages over several
 * instances, so the send rate limit of one instance (at most 600 per minute) does not cap the worker
 * throughput. Without it, every message goes to `INSTANCE_ID`.
 * @param {Record<string, string | undefined>} env
 * @param {number} vu
 * @param {number} iteration
 * @returns {string}
 */
export function instanceFor(env, vu, iteration) {
  const ids = (env.INSTANCE_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (ids.length === 0) return requireEnv(env, 'INSTANCE_ID');
  return ids[(vu + iteration) % ids.length];
}

/**
 * A text message to a test number. The fake Evolution server accepts any number.
 * @param {Record<string, string | undefined>} env
 * @param {number} vu
 * @param {number} iteration
 */
export function messagePayload(env, vu, iteration) {
  return {
    instance_id: instanceFor(env, vu, iteration),
    to: env.TO || '5511999990000',
    type: 'text',
    text: `Load test message ${vu}-${iteration}`,
    priority: 'bulk',
  };
}

/**
 * A unique Idempotency-Key for each request of one run.
 * @param {string} runId
 * @param {number} vu
 * @param {number} iteration
 */
export function idempotencyKey(runId, vu, iteration) {
  return `k6-${runId}-${vu}-${iteration}`;
}

/** @param {Record<string, string | undefined>} env */
export function baseUrl(env) {
  return (env.BASE_URL || 'http://host.docker.internal:3000').replace(/\/+$/, '');
}
