// k6 scenario: GET /v1/messages/{id} (status read) at a constant arrival rate.
// setup() creates SEED_MESSAGES messages; each iteration reads one of them.
// Thresholds: p95 below 100 ms, and less than 1 % errors.
import { check, fail } from 'k6';
import http from 'k6/http';
import {
  STATUS_P95_MS,
  STATUS_REQUEST_NAME,
  baseUrl,
  buildOptions,
  idempotencyKey,
  messagePayload,
  positiveNumber,
  requireEnv,
} from './lib/config.js';

export const options = buildOptions(__ENV, STATUS_REQUEST_NAME, STATUS_P95_MS);

const base = baseUrl(__ENV);
const apiKey = requireEnv(__ENV, 'API_KEY');
const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

export function setup() {
  const count = positiveNumber(__ENV, 'SEED_MESSAGES', 50);
  const runId = `seed-${Date.now()}`;
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const response = http.post(`${base}/v1/messages`, JSON.stringify(messagePayload(__ENV, 0, i)), {
      headers: { ...headers, 'Idempotency-Key': idempotencyKey(runId, 0, i) },
      tags: { name: 'setup POST /v1/messages' },
    });
    if (response.status !== 202) {
      fail(`setup: POST /v1/messages answered ${response.status}: ${response.body}`);
    }
    ids.push(response.json('id'));
  }
  return { ids };
}

export default function readStatus(data) {
  const id = data.ids[(__VU + __ITER) % data.ids.length];
  const response = http.get(`${base}/v1/messages/${id}`, {
    headers,
    tags: { name: STATUS_REQUEST_NAME },
  });
  check(response, {
    'status is 200': (r) => r.status === 200,
    'body has a status': (r) => r.status === 200 && typeof r.json('status') === 'string',
  });
}
