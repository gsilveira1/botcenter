import type { TestingModule } from '@nestjs/testing';
import {
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WebhookSecret,
  verifyWebhook,
} from '@botcenter/contracts';
import type { BotDefinitionInput } from '@botcenter/contracts';
import { newMessageId } from '@botcenter/whatsapp-provider/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationsApiModule } from '../../src/conversations/conversations.module';
import type { Instance } from '../../src/generated/prisma/client';
import { EXTERNAL_HTTP } from '../../src/ports/external-http.port';
import type { ExternalHttpRequest } from '../../src/ports/external-http.port';
import {
  BOT_SECRET_MISSING_ERROR,
  WebhookDeliveryWorker,
} from '../../src/webhooks/webhook-delivery.worker';
import { WEBHOOK_DELIVERY_SETTINGS } from '../../src/webhooks/webhook-delivery.policy';
import { WebhookSweepTask } from '../../src/webhooks/webhook-sweep.task';
import type { WebhookDeliverySettings } from '../../src/webhooks/webhook-delivery.policy';
import { FakeExternalHttp } from '../support/conversation-ports';
import { TestHarness } from '../support/harness';
import { waitFor } from '../support/wait-for';

/**
 * SEC-06 and ARCH-04: the `external` condition and the `call_webhook` action are signed with the secret
 * of the bot, and a `call_webhook` action is a row of `bot_webhook_calls` (written in the step
 * transaction) that the `webhooks` queue delivers at least once, with the retry schedule of the webhooks.
 */

const CALL_URL = 'https://client.example.com/bot-result';
const CHECK_URL = 'https://client.example.com/check';
const SETTINGS: WebhookDeliverySettings = { requestTimeoutMs: 400, retryDelaysSeconds: [0.2, 0.2] };

let h: TestHarness;
let worker: TestingModule;
const http = new FakeExternalHttp();

const definition: BotDefinitionInput = {
  initial_state: 'inicio',
  states: {
    inicio: {
      on_enter: [{ type: 'call_webhook', url: CALL_URL }],
      transitions: [
        {
          condition: { type: 'external', url: CHECK_URL, expect: { path: '/ok', equals: true } },
          target: 'fim',
        },
      ],
    },
    fim: { final: true, transitions: [] },
  },
};

beforeAll(async () => {
  h = await TestHarness.start({
    fakeEvolution: true,
    minio: true,
    modules: [ConversationsApiModule],
  });
  worker = await h.startWorker([], undefined, [
    { provide: EXTERNAL_HTTP, useValue: http },
    { provide: WEBHOOK_DELIVERY_SETTINGS, useValue: SETTINGS },
  ]);
});

afterAll(async () => {
  await h?.close();
});

interface Setup {
  tenantId: string;
  instance: Instance;
  key: string;
  secret: string;
}

let contactSeq = 0;
const nextContact = () => `55119871${String(5000 + (contactSeq += 1)).padStart(5, '0')}`;

function putBot(key: string, instanceIds: string[], headers: Record<string, string> = {}) {
  return h.inject({
    method: 'PUT',
    url: '/v1/bots/signed',
    headers: { ...h.bearer(key), 'content-type': 'application/json', ...headers },
    payload: JSON.stringify({ name: 'Signed', definition, instance_ids: instanceIds }),
  });
}

async function setup(): Promise<Setup> {
  const tenant = await h.createTenant();
  const instance = await h.createInstance(tenant.id, { status: 'connected' });
  await h.whatsapp.createInstance({
    name: instance.providerName,
    webhookUrl: h.webhookUrl,
    webhookSecret: h.env.EVOLUTION_WEBHOOK_SECRET,
  });
  h.evolution.setState(instance.providerName, 'open', '5511912345678');
  const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['bots:write'] });
  const put = await putBot(key, [instance.id], { 'idempotency-key': `put-${tenant.id}` });
  expect(put.statusCode).toBe(200);
  const secret = put.json().signing_secret as string;
  expect(WebhookSecret.safeParse(secret).success).toBe(true);
  // The idempotency store keeps response bodies in plain text: the route must not use it.
  expect(await h.prisma.idempotencyKey.count({ where: { tenantId: tenant.id } })).toBe(0);
  return { tenantId: tenant.id, instance, key, secret };
}

async function say(s: Setup, contact: string, text: string): Promise<void> {
  const id = newMessageId();
  await h.evolution.emitInboundText(s.instance.providerName, { from: contact, text, id });
  await waitFor(async () => {
    const row = await h.prisma.message.findFirst({
      where: { instanceId: s.instance.id, providerMessageId: id },
    });
    return row !== null && !row.botPending;
  });
}

function header(request: ExternalHttpRequest, name: string): string {
  return request.headers?.[name] ?? '';
}

function verify(request: ExternalHttpRequest, secret: string) {
  return verifyWebhook({
    secret,
    signature: header(request, WEBHOOK_SIGNATURE_HEADER),
    timestamp: header(request, WEBHOOK_TIMESTAMP_HEADER),
    rawBody: JSON.stringify(request.body),
  });
}

const callsTo = (url: string, conversationId: string) =>
  http.calls.filter(
    (call) =>
      call.url === url &&
      (call.body as { conversation_id?: string }).conversation_id === conversationId,
  );

describe('bot requests with a signing secret (SEC-06)', () => {
  it('signs the call_webhook action and the external condition with the secret of the bot', async () => {
    const s = await setup();
    const contact = nextContact();
    http.respondWith(async (request) =>
      request.url === CHECK_URL ? { status: 200, json: { ok: true } } : { status: 204, json: null },
    );
    await say(s, contact, 'Oi');
    const conversation = await h.prisma.conversation.findUniqueOrThrow({
      where: { instanceId_contact: { instanceId: s.instance.id, contact } },
    });
    await waitFor(async () => callsTo(CALL_URL, conversation.id).length === 1);
    const [call] = callsTo(CALL_URL, conversation.id);
    expect(verify(call!, s.secret)).toEqual({ valid: true });
    expect(header(call!, WEBHOOK_ID_HEADER)).not.toBe('');

    await say(s, contact, 'pronto');
    const [check] = callsTo(CHECK_URL, conversation.id);
    expect(check).toBeDefined();
    expect(verify(check!, s.secret)).toEqual({ valid: true });
    expect(
      (await h.prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).state,
    ).toBe('fim');
  });

  it('rotates the secret: the new secret is shown one time and both secrets sign for 24 h', async () => {
    const s = await setup();
    const rotated = await h.inject({
      method: 'POST',
      url: '/v1/bots/signed/rotate-secret',
      headers: { ...h.bearer(s.key), 'idempotency-key': 'rotate-1' },
    });
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json().signing_secret as string;
    expect(WebhookSecret.safeParse(next).success).toBe(true);
    expect(next).not.toBe(s.secret);
    expect(await h.prisma.idempotencyKey.count({ where: { tenantId: s.tenantId } })).toBe(0);
    const read = await h.inject({
      method: 'GET',
      url: '/v1/bots/signed',
      headers: h.bearer(s.key),
    });
    expect(read.json().signing_secret).toBeUndefined();

    const contact = nextContact();
    http.respondWith(async () => ({ status: 204, json: null }));
    await say(s, contact, 'Oi');
    const conversation = await h.prisma.conversation.findUniqueOrThrow({
      where: { instanceId_contact: { instanceId: s.instance.id, contact } },
    });
    await waitFor(async () => callsTo(CALL_URL, conversation.id).length === 1);
    const [call] = callsTo(CALL_URL, conversation.id);
    expect(verify(call!, next)).toEqual({ valid: true });
    expect(verify(call!, s.secret)).toEqual({ valid: true });
  });
});

describe('call_webhook delivery at least once (ARCH-04)', () => {
  it('writes the call in the step transaction and retries a 503 with the same Webhook-Id', async () => {
    const s = await setup();
    const contact = nextContact();
    let answers = 0;
    http.respondWith(async (request) => {
      if (request.url !== CALL_URL) {
        return { status: 200, json: { ok: false } };
      }
      answers += 1;
      return answers === 1 ? { status: 503, json: null } : { status: 204, json: null };
    });
    await say(s, contact, 'Oi');
    const conversation = await h.prisma.conversation.findUniqueOrThrow({
      where: { instanceId_contact: { instanceId: s.instance.id, contact } },
    });
    await waitFor(async () => callsTo(CALL_URL, conversation.id).length === 2);
    const [first, second] = callsTo(CALL_URL, conversation.id);
    expect(header(second!, WEBHOOK_ID_HEADER)).toBe(header(first!, WEBHOOK_ID_HEADER));
    await waitFor(async () => {
      const row = await h.prisma.botWebhookCall.findFirst({
        where: { conversationId: conversation.id },
      });
      return row?.status === 'succeeded';
    });
    const row = await h.prisma.botWebhookCall.findFirstOrThrow({
      where: { conversationId: conversation.id },
    });
    expect(row).toMatchObject({
      id: header(first!, WEBHOOK_ID_HEADER),
      tenantId: s.tenantId,
      url: CALL_URL,
      attempts: 2,
      lastStatusCode: 204,
      leaseExpiresAt: null,
    });
    expect(row.payload).toMatchObject({ conversation_id: conversation.id, bot_id: 'signed' });
  });

  it('sweeps an overdue call without a job and delivers it', async () => {
    const s = await setup();
    const contact = nextContact();
    http.respondWith(async (request) =>
      request.url === CALL_URL ? { status: 204, json: null } : { status: 200, json: { ok: false } },
    );
    await say(s, contact, 'Oi');
    const conversation = await h.prisma.conversation.findUniqueOrThrow({
      where: { instanceId_contact: { instanceId: s.instance.id, contact } },
    });
    const bot = await h.prisma.bot.findFirstOrThrow({ where: { tenantId: s.tenantId } });
    const lost = await h.prisma.botWebhookCall.create({
      data: {
        tenantId: s.tenantId,
        botId: bot.id,
        conversationId: conversation.id,
        url: CALL_URL,
        payload: { conversation_id: conversation.id, lost: true },
        nextAttemptAt: new Date(Date.now() - 120_000),
      },
    });
    const result = await worker.get(WebhookSweepTask).run(new Date());
    expect(result['requeued_bot_calls']).toBeGreaterThanOrEqual(1);
    await waitFor(
      async () =>
        (await h.prisma.botWebhookCall.findUniqueOrThrow({ where: { id: lost.id } })).status ===
        'succeeded',
    );
  });

  it('does not send a call of a bot without a signing secret, and ends it dead', async () => {
    const s = await setup();
    const contact = nextContact();
    http.respondWith(async () => ({ status: 200, json: { ok: false } }));
    await say(s, contact, 'Oi');
    const conversation = await h.prisma.conversation.findUniqueOrThrow({
      where: { instanceId_contact: { instanceId: s.instance.id, contact } },
    });
    const bot = await h.prisma.bot.findFirstOrThrow({ where: { tenantId: s.tenantId } });
    await h.prisma.bot.update({ where: { id: bot.id }, data: { secretEncrypted: null } });
    const call = await h.prisma.botWebhookCall.create({
      data: {
        tenantId: s.tenantId,
        botId: bot.id,
        conversationId: conversation.id,
        url: CALL_URL,
        payload: { conversation_id: 'unsigned' },
        attempts: 2,
        nextAttemptAt: new Date(),
      },
    });
    const before = http.calls.length;
    const outcome = await worker
      .get(WebhookDeliveryWorker)
      .deliverBotCall({ tenantId: s.tenantId, deliveryId: call.id });
    expect(outcome).toBe('dead');
    expect(http.calls.slice(before).filter((c) => c.url === CALL_URL)).toHaveLength(0);
    expect(
      await h.prisma.botWebhookCall.findUniqueOrThrow({ where: { id: call.id } }),
    ).toMatchObject({ status: 'dead', lastError: BOT_SECRET_MISSING_ERROR });
    expect(h.alerts).toContainEqual(
      expect.objectContaining({ dedupeKey: `bot-webhook:${s.tenantId}:${bot.id}` }),
    );

    // The next PUT gives the bot a new secret, one time.
    const put = await putBot(s.key, [s.instance.id]);
    expect(WebhookSecret.safeParse(put.json().signing_secret).success).toBe(true);
    expect((await putBot(s.key, [s.instance.id])).json().signing_secret).toBeUndefined();
  });
});
