import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SEND_P95_MS,
  SEND_REQUEST_NAME,
  baseUrl,
  buildOptions,
  idempotencyKey,
  messagePayload,
  positiveNumber,
  requireEnv,
} from '../lib/config.js';

describe('buildOptions', () => {
  it('has the thresholds of the architecture: p95 below 150 ms and errors below 1 %', () => {
    const options = buildOptions({}, SEND_REQUEST_NAME, SEND_P95_MS);
    assert.deepEqual(options.thresholds, {
      'http_req_duration{name:POST /v1/messages,expected_response:true}': ['p(95)<150'],
      http_req_failed: ['rate<0.01'],
      checks: ['rate>0.99'],
    });
  });

  it('uses a constant arrival rate with the defaults 50 per second for 2 minutes', () => {
    const { steady } = buildOptions({}, SEND_REQUEST_NAME, SEND_P95_MS).scenarios;
    assert.equal(steady.executor, 'constant-arrival-rate');
    assert.equal(steady.rate, 50);
    assert.equal(steady.duration, '2m');
    assert.equal(steady.preAllocatedVUs, 10);
    assert.equal(steady.maxVUs, 40);
  });

  it('reads RATE, DURATION, VUS, and MAX_VUS from the environment', () => {
    const { steady } = buildOptions(
      { RATE: '200', DURATION: '30s', VUS: '20', MAX_VUS: '100' },
      SEND_REQUEST_NAME,
      SEND_P95_MS,
    ).scenarios;
    assert.deepEqual(
      [steady.rate, steady.duration, steady.preAllocatedVUs, steady.maxVUs],
      [200, '30s', 20, 100],
    );
  });

  it('refuses a rate that is not a positive number', () => {
    assert.throws(() => buildOptions({ RATE: '-1' }, SEND_REQUEST_NAME, 150), /RATE must be/);
    assert.throws(() => positiveNumber({ VUS: 'abc' }, 'VUS', 1), /VUS must be/);
  });
});

describe('request helpers', () => {
  it('requires INSTANCE_ID for the payload and gives a valid text message', () => {
    assert.throws(() => messagePayload({}, 1, 1), /INSTANCE_ID is required/);
    const payload = messagePayload({ INSTANCE_ID: 'i-1' }, 3, 7);
    assert.deepEqual(payload, {
      instance_id: 'i-1',
      to: '5511999990000',
      type: 'text',
      text: 'Load test message 3-7',
      priority: 'bulk',
    });
    assert.match(payload.to, /^[1-9]\d{9,14}$/);
  });

  it('gives a different Idempotency-Key for each VU and iteration', () => {
    const keys = new Set([
      idempotencyKey('r', 1, 1),
      idempotencyKey('r', 1, 2),
      idempotencyKey('r', 2, 1),
    ]);
    assert.equal(keys.size, 3);
  });

  it('removes the trailing slash of BASE_URL and has a default for the container', () => {
    assert.equal(baseUrl({ BASE_URL: 'http://api:3000/' }), 'http://api:3000');
    assert.equal(baseUrl({}), 'http://host.docker.internal:3000');
  });

  it('refuses an empty required value', () => {
    assert.throws(() => requireEnv({ API_KEY: '' }, 'API_KEY'), /API_KEY is required/);
  });
});
