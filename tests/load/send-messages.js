// k6 scenario: POST /v1/messages at a constant arrival rate.
// Thresholds: p95 below 150 ms for the 202 answer, and less than 1 % errors.
// Run: see README.md (`pnpm --filter @botcenter/tests-load k6:send`).
import { check } from 'k6';
import http from 'k6/http';
import {
  SEND_P95_MS,
  SEND_REQUEST_NAME,
  baseUrl,
  buildOptions,
  idempotencyKey,
  messagePayload,
  requireEnv,
} from './lib/config.js';

export const options = buildOptions(__ENV, SEND_REQUEST_NAME, SEND_P95_MS);

const url = `${baseUrl(__ENV)}/v1/messages`;
const apiKey = requireEnv(__ENV, 'API_KEY');
const runId = __ENV.RUN_ID || `${Date.now()}`;

export default function sendMessage() {
  const response = http.post(url, JSON.stringify(messagePayload(__ENV, __VU, __ITER)), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey(runId, __VU, __ITER),
    },
    tags: { name: SEND_REQUEST_NAME },
  });
  check(response, {
    'status is 202': (r) => r.status === 202,
    'body has an id': (r) => r.status === 202 && typeof r.json('id') === 'string',
  });
}
