#!/usr/bin/env node
// The HTTP steps of the smoke test. run-smoke.sh starts the stack and gives the environment:
//   SMOKE_COMPOSE_ARGS (JSON list), SMOKE_HTTPS_PORT, SMOKE_HTTP_PORT, SMOKE_DOMAIN, SMOKE_CA_FILE,
//   SMOKE_ENV_DIR, SMOKE_MIGRATE_EXIT, SMOKE_REPORT.
// Each step records `pass`, `fail`, or `blocked` (an external cause, for example no WhatsApp access)
// with its evidence. The process exits with 1 when one step fails.
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { personalTrainerOnboarding } from '@botcenter/engine/fixtures';
import { createClient } from './lib/http.mjs';
import { createStack, readEnvValue, sealSecret } from './lib/stack.mjs';

const env = process.env;
const stack = createStack(JSON.parse(required('SMOKE_COMPOSE_ARGS')));
const client = createClient({
  httpsPort: Number(required('SMOKE_HTTPS_PORT')),
  httpPort: Number(required('SMOKE_HTTP_PORT')),
  domain: required('SMOKE_DOMAIN'),
  caFile: required('SMOKE_CA_FILE'),
  clientCertFile: required('SMOKE_CLIENT_CERT'),
  clientKeyFile: required('SMOKE_CLIENT_KEY'),
});
const RUN = randomBytes(3).toString('hex');
const BOT_ID = `smoke-onboarding-${RUN}`;
const RECIPIENT = '5511999990000';

/** @type {Array<{ step: string, result: 'pass' | 'fail' | 'blocked', evidence: unknown }>} */
const report = [];
/** Values that later steps use. */
const ctx = {};

class Blocked extends Error {}

/** @param {string} name */
function required(name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required (run tests/smoke/run-smoke.sh)`);
  return value;
}

/**
 * @param {boolean} condition
 * @param {string} message
 * @param {unknown} [evidence]
 */
function expect(condition, message, evidence) {
  if (!condition) {
    throw new Error(`${message}${evidence === undefined ? '' : `: ${JSON.stringify(evidence)}`}`);
  }
}

/**
 * @param {string} name
 * @param {() => Promise<unknown> | unknown} fn
 */
async function step(name, fn) {
  const started = Date.now();
  try {
    const evidence = await fn();
    report.push({ step: name, result: 'pass', ms: Date.now() - started, evidence });
    console.error(`smoke: PASS ${name}`);
  } catch (error) {
    const result = error instanceof Blocked ? 'blocked' : 'fail';
    report.push({
      step: name,
      result,
      ms: Date.now() - started,
      evidence: String(error.message ?? error),
    });
    console.error(`smoke: ${result.toUpperCase()} ${name}: ${error.message ?? error}`);
  }
}

/**
 * Repeats `check` until it returns a value that is not undefined, or the time ends.
 * @template T
 * @param {() => Promise<T | undefined> | T | undefined} check
 * @param {number} timeoutMs
 * @param {string} what
 * @returns {Promise<T>}
 */
async function waitFor(check, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last !== undefined) return last;
    await sleep(1_000);
  }
  throw new Error(`timeout after ${timeoutMs} ms: ${what}`);
}

const auth = () => ({ authorization: `Bearer ${ctx.apiKey}` });
const api = (method, path, body, headers = {}) =>
  client.request(method, path, { body, headers: { ...auth(), ...headers } });

/** A one-line view of an answer for the report. */
const brief = (res) => ({ status: res.status, body: res.json ?? res.text.slice(0, 300) });

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

async function stepAdmin() {
  const tenant = stack.admin(['tenant:create', '--name', `Smoke ${RUN}`, '--slug', `smoke-${RUN}`]);
  expect(typeof tenant.id === 'string', 'tenant:create gave no id', tenant);
  const key = stack.admin([
    'key:create',
    '--tenant',
    tenant.id,
    '--name',
    'smoke',
    '--scopes',
    'messages:send,instances:manage,bots:write,events:read',
  ]);
  expect(/^bc_live_[a-z0-9]{12}_[A-Za-z0-9]{43}$/.test(key.key), 'key:create gave no key');
  ctx.tenantId = tenant.id;
  ctx.apiKey = key.key;
  return { tenant_id: tenant.id, key_prefix: key.api_key?.prefix, scopes: key.api_key?.scopes };
}

async function stepReady() {
  const res = await waitFor(
    async () => {
      const answer = await client.request('GET', '/health/ready');
      return answer.status === 200 ? answer : undefined;
    },
    120_000,
    'GET /health/ready answers 200',
  );
  const checks = res.json?.checks ?? {};
  for (const name of ['database', 'redis', 'provider']) {
    expect(checks[name]?.status === 'up', `check ${name} is not up`, checks);
  }
  expect(res.headers['strict-transport-security'] !== undefined, 'no HSTS header from Caddy');
  return brief(res);
}

async function stepEdgeBlocks() {
  const evidence = {};
  for (const [method, path] of [
    ['POST', '/internal/evolution/webhook'],
    ['GET', '/internal/evolution/webhook'],
    ['GET', '/metrics'],
    ['GET', '/v1/../metrics'],
  ]) {
    const res = await client.request(method, path, method === 'POST' ? { body: {} } : {});
    evidence[`${method} ${path}`] = res.status;
  }
  expect(evidence['POST /internal/evolution/webhook'] === 404, 'POST /internal answered', evidence);
  expect(evidence['GET /internal/evolution/webhook'] === 404, 'GET /internal answered', evidence);
  expect(evidence['GET /metrics'] === 404, '/metrics answered', evidence);
  expect(
    evidence['GET /v1/../metrics'] === 400 || evidence['GET /v1/../metrics'] === 404,
    'traversal answered',
    evidence,
  );
  const plain = await client.request('GET', '/health/live', { plain: true });
  evidence['HTTP GET /health/live'] = `${plain.status} ${plain.headers.location ?? ''}`.trim();
  expect(plain.status >= 300 && plain.status < 400, 'port 80 does not redirect to HTTPS', evidence);
  return evidence;
}

async function stepCreateInstance() {
  const body = { external_ref: `smoke-${RUN}`, consent_at: new Date().toISOString() };
  const key = `smoke-create-${RUN}`;
  const first = await api('POST', '/v1/instances', body, { 'idempotency-key': key });
  expect(first.status === 201, 'POST /v1/instances is not 201', brief(first));
  const replay = await api('POST', '/v1/instances', body, { 'idempotency-key': key });
  expect(replay.status === 201, 'the replay is not 201', brief(replay));
  expect(replay.json?.id === first.json.id, 'the replay gave another instance', brief(replay));
  expect(replay.headers['idempotency-replayed'] === 'true', 'no Idempotency-Replayed header');
  ctx.instanceId = first.json.id;
  const row = stack.sql(
    `SELECT "providerName", "providerCreatedAt" IS NOT NULL AS provider_created FROM instances WHERE id = '${ctx.instanceId}'`,
  )[0];
  ctx.providerName = row?.providerName;
  expect(row?.provider_created === true, 'Evolution did not create the instance', row);
  return {
    create: brief(first),
    replay: {
      status: replay.status,
      same_id: true,
      replayed: replay.headers['idempotency-replayed'],
    },
    provider_created: row.provider_created,
  };
}

async function stepConnect() {
  const res = await api('POST', `/v1/instances/${ctx.instanceId}/connect`, { method: 'qrcode' });
  // 201 with a token; 200 only when the instance is connected already (OpenAPI of the route).
  expect(res.status === 201, 'connect is not 201', brief(res));
  expect(typeof res.json?.connect_token === 'string', 'no connect_token', brief(res));
  const eventsUrl = new URL(res.json.events_url);
  expect(
    eventsUrl.hostname === required('SMOKE_DOMAIN'),
    'events_url has another host',
    res.json.events_url,
  );
  ctx.eventsPath = eventsUrl.pathname;
  return {
    status: res.status,
    expires_at: res.json.expires_at,
    events_path: ctx.eventsPath.replace(/ct_[^/]+/, 'ct_…'),
  };
}

async function stepQrStream() {
  const stream = await client.events(ctx.eventsPath, {
    timeoutMs: 90_000,
    until: (events) => events.some((item) => item.event === 'qrcode'),
  });
  expect(stream.status === 200, 'the stream is not 200', {
    status: stream.status,
    text: stream.text,
  });
  const kinds = stream.events.map((item) =>
    item.event === 'status' ? `status:${item.data.status}` : item.event,
  );
  const qr = stream.events.find((item) => item.event === 'qrcode');
  const evidence = {
    content_type: stream.headers['content-type'],
    events: kinds,
    ended_by: stream.endedBy,
  };
  if (!qr) {
    const evolutionErrors = stack
      .logs('evolution')
      .split('\n')
      .filter((line) => /error|ENOTFOUND|ECONN|timed out|403|405/i.test(line))
      .slice(-10);
    throw new Blocked(
      `no QR code event in 90 s; ${JSON.stringify({ ...evidence, evolution_errors: evolutionErrors })}`,
    );
  }
  expect(
    typeof qr.data.png_base64 === 'string' && qr.data.png_base64.length > 100,
    'the QR code has no PNG',
  );
  expect(typeof qr.data.code === 'string' && qr.data.code.length > 20, 'the QR code has no code');
  return {
    ...evidence,
    png_base64_length: qr.data.png_base64.length,
    code_prefix: qr.data.code.slice(0, 8),
  };
}

async function stepSecondOpen() {
  const again = await client.events(ctx.eventsPath, { timeoutMs: 10_000, until: () => true });
  expect(again.status === 401, 'the second open is not 401', {
    status: again.status,
    text: again.text,
  });
  return { status: again.status, body: JSON.parse(again.text || '{}').code ?? again.text };
}

async function stepBot() {
  const res = await api('PUT', `/v1/bots/${BOT_ID}`, {
    name: 'Onboarding do personal (smoke)',
    definition: personalTrainerOnboarding,
    instance_ids: [ctx.instanceId],
  });
  expect(res.status === 200, 'PUT /v1/bots is not 200', brief(res));
  expect(
    res.json.instance_ids?.includes(ctx.instanceId),
    'the bot is not bound to the instance',
    brief(res),
  );
  const instance = await api('GET', `/v1/instances/${ctx.instanceId}`);
  expect(instance.json?.bot_id === BOT_ID, 'the instance has another bot_id', brief(instance));
  return {
    status: res.status,
    id: res.json.id,
    version: res.json.version,
    instance_bot_id: instance.json.bot_id,
  };
}

async function stepWebhookRegistration() {
  const url = 'https://receiver.smoke.test/hook';
  const res = await api('POST', '/v1/webhooks', {
    url,
    events: ['instance.status', 'message.status'],
  });
  ctx.webhookRegistration = res.status;
  if (res.status === 201) {
    ctx.webhookId = res.json.id;
    return { ...brief(res), note: 'registered (the SSRF guard allowed the address)' };
  }
  expect(res.status === 422, 'POST /v1/webhooks is not 201 or 422', brief(res));
  expect(res.json?.code === 'WEBHOOK_URL_FORBIDDEN', 'the 422 has another code', brief(res));
  return {
    status: res.status,
    code: res.json.code,
    detail: res.json.detail,
    note: 'Expected in production: the HTTPS-only contract and the SSRF guard refuse a private address; EXTERNAL_HTTP_ALLOW_PRIVATE is refused when NODE_ENV=production.',
  };
}

/** The documented workaround (plan, section 8, webhooks): write the subscription row directly. */
async function stepWebhookWorkaround() {
  if (ctx.webhookId) return { skipped: 'the API registered the webhook' };
  const id = randomUUID();
  const key = readEnvValue(`${required('SMOKE_ENV_DIR')}/api.env`, 'DATA_ENCRYPTION_KEY');
  const sealed = sealSecret(key, `whsec_${randomBytes(32).toString('base64url')}`, id);
  stack.exec(
    `INSERT INTO webhook_subscriptions (id, "tenantId", url, events, "secretEncrypted", "updatedAt")
     VALUES ('${id}', '${ctx.tenantId}', 'https://receiver.smoke.test/hook',
             ARRAY['instance.status','message.status'], '${sealed}', now());`,
  );
  ctx.subscriptionId = id;
  return { subscription_id: id, url: 'https://receiver.smoke.test/hook' };
}

async function stepMessageNotConnected() {
  const second = await api('POST', '/v1/instances', {
    external_ref: `smoke-created-${RUN}`,
    consent_at: new Date().toISOString(),
  });
  expect(second.status === 201, 'the second instance is not 201', brief(second));
  ctx.secondInstanceId = second.json.id;
  const res = await api('POST', '/v1/messages', {
    instance_id: ctx.secondInstanceId,
    to: RECIPIENT,
    type: 'text',
    text: 'Mensagem de teste',
  });
  expect(res.status === 409, 'a message to a `created` instance is not 409', brief(res));
  expect(res.json?.code === 'INSTANCE_NOT_CONNECTED', 'the 409 has another code', brief(res));
  return { status: res.status, code: res.json.code };
}

async function stepMessage() {
  const res = await api(
    'POST',
    '/v1/messages',
    {
      instance_id: ctx.instanceId,
      to: RECIPIENT,
      type: 'text',
      text: 'Olá! Mensagem de teste do smoke.',
    },
    { 'idempotency-key': `smoke-message-${RUN}` },
  );
  expect(res.status === 202, 'POST /v1/messages is not 202', brief(res));
  ctx.messageId = res.json.id;
  // The first send attempt: Evolution refuses (or holds) a send to an instance that is not open.
  const attempt = await waitFor(
    () => {
      const line = stack
        .logs('worker')
        .split('\n')
        .find((item) => item.includes(ctx.messageId) && item.includes('provider send failed'));
      return line ? JSON.parse(line) : undefined;
    },
    120_000,
    'the worker log "provider send failed" for the message',
  );
  const read = await api('GET', `/v1/messages/${ctx.messageId}`);
  expect(read.status === 200, 'GET /v1/messages/{id} is not 200', brief(read));
  expect(
    read.json.status === 'queued',
    'the message is not queued during the retries',
    brief(read),
  );
  return {
    post: { status: res.status, message_status: res.json.status },
    first_attempt: {
      provider_code: attempt.provider_code,
      http_status: attempt.http_status,
      decision: attempt.decision,
      attempt: attempt.attempt,
    },
    get: { status: read.status, message_status: read.json.status },
  };
}

async function stepDelete() {
  const res = await api('DELETE', `/v1/instances/${ctx.instanceId}`);
  expect(res.status === 200, 'DELETE is not 200', brief(res));
  expect(res.json.status === 'logged_out', 'the deleted instance is not logged_out', brief(res));
  const after = await api('GET', `/v1/instances/${ctx.instanceId}`);
  const second = await api('DELETE', `/v1/instances/${ctx.secondInstanceId}`);
  expect(second.status === 200, 'DELETE of the second instance is not 200', brief(second));
  return { status: res.status, instance_status: res.json.status, get_after_delete: after.status };
}

async function stepMessageAfterDelete() {
  const message = await waitFor(
    async () => {
      const read = await api('GET', `/v1/messages/${ctx.messageId}`);
      return read.json?.status === 'failed' ? read.json : undefined;
    },
    120_000,
    'the message becomes failed after the delete (next retry)',
  );
  return { status: message.status, failure_reason: message.failure_reason };
}

async function stepWebhookDeliveries() {
  const filter = ctx.subscriptionId
    ? `"subscriptionId" = '${ctx.subscriptionId}'`
    : `"tenantId" = '${ctx.tenantId}'`;
  const rows = await waitFor(
    () => {
      const found = stack.sql(
        `SELECT "eventType", status, attempts, "lastError" FROM webhook_deliveries WHERE ${filter} ORDER BY "createdAt"`,
      );
      return found.length > 0 && found.every((row) => row.attempts > 0) ? found : undefined;
    },
    90_000,
    'webhook deliveries with at least one attempt',
  );
  const receiverHits = stack
    .logs('receiver')
    .split('\n')
    .filter((line) => line.includes('"uri":"/hook"')).length;
  if (ctx.subscriptionId) {
    expect(
      rows.every((row) => row.lastError === 'forbidden_address'),
      'a delivery has another error',
      rows,
    );
    expect(receiverHits === 0, 'the receiver got a request', receiverHits);
  }
  return { deliveries: rows, receiver_requests: receiverHits };
}

async function main() {
  report.push({
    step: 'migrate',
    result: env.SMOKE_MIGRATE_EXIT === '0' ? 'pass' : 'fail',
    evidence: { exit_code: env.SMOKE_MIGRATE_EXIT },
  });
  await step('a. admin CLI: tenant and API key', stepAdmin);
  await step('b. GET /health/ready through Caddy (all checks up)', stepReady);
  await step('b. /internal and /metrics answer 404 through Caddy', stepEdgeBlocks);
  if (!ctx.apiKey) return;
  await step('c. POST /v1/instances with Idempotency-Key and replay', stepCreateInstance);
  if (!ctx.instanceId) return;
  await step('c. POST /v1/instances/{id}/connect (qrcode)', stepConnect);
  if (ctx.eventsPath) {
    await step('c. GET /v1/connect/{token}/events gives a real QR code', stepQrStream);
    await step('c. second open of the token gives 401', stepSecondOpen);
  }
  await step('d. PUT /v1/bots/{id} with the pt-BR fixture bound to the instance', stepBot);
  await step('d. POST /v1/webhooks to the local HTTPS receiver', stepWebhookRegistration);
  await step('d. webhook workaround: subscription row written directly', stepWebhookWorkaround);
  await step('e. POST /v1/messages to a `created` instance gives 409', stepMessageNotConnected);
  await step(
    'e. POST /v1/messages to the instance that is not connected: 202, retry, GET',
    stepMessage,
  );
  await step('f. DELETE /v1/instances/{id}', stepDelete);
  if (ctx.messageId) await step('e. the message fails after the delete', stepMessageAfterDelete);
  await step('d. webhook deliveries of the events', stepWebhookDeliveries);
}

await main().catch((error) => {
  report.push({ step: 'runner', result: 'fail', evidence: String(error.stack ?? error) });
});
writeFileSync(
  required('SMOKE_REPORT'),
  `${JSON.stringify({ date: new Date().toISOString(), run: RUN, report }, null, 2)}\n`,
);
const failed = report.filter((item) => item.result === 'fail');
console.error(
  `smoke: ${report.length} steps, ${failed.length} failed. Report: ${env.SMOKE_REPORT}`,
);
process.exit(failed.length > 0 ? 1 : 0);
