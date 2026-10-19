import type { TestingModule } from '@nestjs/testing';
import type { BotDefinitionInput } from '@botcenter/contracts';
import { timerJobId } from '@botcenter/engine';
import {
  ONBOARDING_SLOTS_URL,
  ONBOARDING_WEBHOOK_URL,
  personalTrainerOnboarding,
} from '@botcenter/engine/fixtures';
import { newMessageId } from '@botcenter/whatsapp-provider/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConversationsApiModule,
  ConversationsWorkerModule,
} from '../../src/conversations/conversations.module';
import { conversationLockName } from '../../src/conversations/conversation-keys';
import { TIMER_JOB_NAME } from '../../src/conversations/conversation-timers.service';
import { InboundStoreService } from '../../src/conversations/worker/inbound-store.service';
import { InstanceResolver } from '../../src/conversations/worker/instance-context';
import { MessageReceivedHandler } from '../../src/conversations/worker/message-received.handler';
import type { Instance } from '../../src/generated/prisma/client';
import { inboundJobId } from '../../src/inbound/inbound-ingest.service';
import { QueuesService } from '../../src/queues/queues.service';
import { DistributedLockService } from '../../src/services/lock.service';
import {
  FakeExternalHttp,
  FakeOutboundMessages,
  conversationPortsModule,
} from '../support/conversation-ports';
import { TestHarness } from '../support/harness';
import { startMinio } from '../support/minio';
import type { TestMinio } from '../support/minio';
import { waitFor } from '../support/wait-for';

let h: TestHarness;
let minio: TestMinio;
let worker: TestingModule;
const outbound = new FakeOutboundMessages();
const http = new FakeExternalHttp();

beforeAll(async () => {
  minio = await startMinio();
  h = await TestHarness.start({
    fakeEvolution: true,
    modules: [ConversationsApiModule],
    env: minio.env,
  });
  worker = await h.startWorker([
    ConversationsWorkerModule,
    conversationPortsModule(outbound, http),
  ]);
});

afterAll(async () => {
  await h?.close();
  await minio?.stop();
});

interface Setup {
  tenantId: string;
  instance: Instance;
  key: string;
}

let contactSeq = 0;
const nextContact = () => `55119876${String(5000 + (contactSeq += 1)).padStart(5, '0')}`;

async function setup(definition: BotDefinitionInput = personalTrainerOnboarding): Promise<Setup> {
  const tenant = await h.createTenant();
  const instance = await h.createInstance(tenant.id);
  await h.whatsapp.createInstance({
    name: instance.providerName,
    webhookUrl: h.webhookUrl,
    webhookSecret: h.env.EVOLUTION_WEBHOOK_SECRET,
  });
  const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['bots:write'] });
  const put = await putBot(key, definition, [instance.id]);
  expect(put.statusCode).toBe(200);
  return { tenantId: tenant.id, instance, key };
}

function putBot(key: string, definition: BotDefinitionInput, instanceIds: string[]) {
  return h.inject({
    method: 'PUT',
    url: '/v1/bots/onboarding',
    headers: { ...h.bearer(key), 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Onboarding', definition, instance_ids: instanceIds }),
  });
}

/** Sends a text from the contact and waits until the worker consumed it. */
async function say(s: Setup, contact: string, text: string): Promise<string> {
  const id = newMessageId();
  await h.evolution.emitInboundText(s.instance.providerName, { from: contact, text, id });
  await waitForConsumed(s.instance.id, id);
  return id;
}

async function waitForConsumed(instanceId: string, providerMessageId: string): Promise<void> {
  await waitFor(async () => {
    const row = await h.prisma.message.findFirst({ where: { instanceId, providerMessageId } });
    return row !== null && !row.botPending;
  });
}

function conversation(s: Setup, contact: string) {
  return h.prisma.conversation.findUniqueOrThrow({
    where: { instanceId_contact: { instanceId: s.instance.id, contact } },
  });
}

function repliesOf(conversationId: string) {
  return outbound.created.filter((reply) => reply.conversationId === conversationId);
}

const timers = () => h.get(QueuesService).get('timers');

async function fireTimer(conversationId: string, version: number): Promise<void> {
  const job = await timers().getJob(timerJobId(conversationId, version));
  expect(job).toBeDefined();
  await job!.promote();
  await waitFor(async () => (await job!.isCompleted()) || (await job!.isFailed()));
}

describe('message.received with a bot', () => {
  it('runs the onboarding bot from the first message to the end on its pinned version', async () => {
    const s = await setup();
    const contact = nextContact();
    http.respondWith(async (request) =>
      request.url === ONBOARDING_SLOTS_URL
        ? { status: 200, json: { agenda: { aberta: true } } }
        : { status: 204, json: null },
    );

    await say(s, contact, 'Oi');
    const started = await conversation(s, contact);
    expect(started).toMatchObject({ state: 'inicio', botVersion: 1, version: 0 });
    const [welcome] = repliesOf(started.id);
    expect(welcome).toMatchObject({ priority: 'reply', to: contact, content: { type: 'buttons' } });
    expect(welcome!.typingDelayMs).toBeGreaterThanOrEqual(800);
    expect(outbound.dispatched.map((d) => d.messageId)).toContain(welcome!.messageId);
    expect(await timers().getJob(timerJobId(started.id, 0))).toBeDefined();

    // "1" answers the text menu: the button "comecar".
    await say(s, contact, '1');
    expect((await conversation(s, contact)).state).toBe('pedir_nome');
    expect(await timers().getJob(timerJobId(started.id, 0))).toBeUndefined();

    // A new version does not change the running conversation.
    const v2 = structuredClone(personalTrainerOnboarding);
    v2.states['pedir_objetivo']!.on_enter = [
      { type: 'send_message', message: { type: 'text', text: 'Versão 2' } },
    ];
    expect((await putBot(s.key, v2, [s.instance.id])).json().version).toBe(2);

    await say(s, contact, 'Ana');
    expect(repliesOf(started.id).at(-1)?.content).toMatchObject({ type: 'list' });
    await say(s, contact, 'emagrecer'); // the title of a list row, without case
    await say(s, contact, '3');
    await say(s, contact, '72,5');
    expect((await conversation(s, contact)).state).toBe('confirmar');
    await say(s, contact, '1'); // "Está certo": the external condition is true

    const ended = await conversation(s, contact);
    expect(ended).toMatchObject({
      state: 'concluido',
      botVersion: 1,
      variables: { nome: 'Ana', objetivo: 'emagrecimento', dias_semana: 3, peso_kg: 72.5 },
    });
    await waitFor(() => http.calls.some((call) => call.url === ONBOARDING_WEBHOOK_URL));
    const webhook = http.calls.find((call) => call.url === ONBOARDING_WEBHOOK_URL);
    expect(webhook?.body).toMatchObject({
      conversation_id: started.id,
      bot_id: 'onboarding',
      bot_version: 1,
      state: 'concluido',
      variables: { nome: 'Ana', peso_kg: 72.5 },
    });

    // A message after the end starts a new conversation on the same row with the current version.
    await say(s, contact, 'Oi de novo');
    const restarted = await conversation(s, contact);
    expect(restarted).toMatchObject({ id: started.id, state: 'inicio', botVersion: 2 });
    expect(restarted.variables).toMatchObject({ nome: '' });

    const transitions = await h.prisma.conversationTransition.findMany({
      where: { conversationId: started.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(transitions.map((t) => `${t.trigger}:${t.toState}`)).toEqual([
      'start:inicio',
      'message:pedir_nome',
      'message:pedir_objetivo',
      'message:pedir_dias',
      'message:pedir_peso',
      'message:confirmar',
      'message:concluido',
      'start:inicio',
    ]);
  });

  it('writes the message.received and conversation.transitioned events', async () => {
    const s = await setup();
    const contact = nextContact();
    await say(s, contact, 'Oi');
    await say(s, contact, 'quero');
    const row = await conversation(s, contact);
    const events = await h.prisma.outboxEvent.findMany({
      where: { tenantId: s.tenantId },
      orderBy: { createdAt: 'asc' },
    });
    const received = events.filter((event) => event.type === 'message.received');
    expect(received.map((event) => event.payload)).toEqual([
      expect.objectContaining({ from: contact, type: 'text', text: 'Oi' }),
      expect.objectContaining({ from: contact, text: 'quero', conversation_id: row.id }),
    ]);
    expect((received[0]!.payload as Record<string, unknown>)['conversation_id']).toBeUndefined();
    const moved = events.filter((event) => event.type === 'conversation.transitioned');
    expect(moved.map((event) => event.payload)).toEqual([
      expect.objectContaining({ trigger: 'start', from_state: null, to_state: 'inicio' }),
      expect.objectContaining({ trigger: 'message', from_state: 'inicio', to_state: 'pedir_nome' }),
    ]);
  });

  it('fires a state timeout, and a stale timer changes nothing', async () => {
    const s = await setup();
    const contact = nextContact();
    await say(s, contact, 'Oi');
    const started = await conversation(s, contact);

    // A stale timer (an old version) is a no-op.
    await timers().add(
      TIMER_JOB_NAME,
      {
        tenantId: s.tenantId,
        conversationId: started.id,
        state: 'inicio',
        conversationVersion: 99,
      },
      { jobId: timerJobId(started.id, 99), delay: 60_000 },
    );
    await fireTimer(started.id, 99);
    expect((await conversation(s, contact)).version).toBe(0);

    await fireTimer(started.id, 0);
    const reminded = await conversation(s, contact);
    expect(reminded).toMatchObject({ state: 'lembrete', version: 1 });
    expect(repliesOf(started.id).at(-1)?.content).toMatchObject({ type: 'text' });
    const last = await h.prisma.conversationTransition.findFirstOrThrow({
      where: { conversationId: started.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(last).toMatchObject({ trigger: 'timeout', fromState: 'inicio', toState: 'lembrete' });
    expect(await timers().getJob(timerJobId(started.id, 1))).toBeDefined();
  });

  it('stops the bot in handoff (engine action and API route) and stores the messages', async () => {
    const s = await setup();
    const contact = nextContact();
    await say(s, contact, 'Oi');
    await say(s, contact, '2'); // "Falar com o personal": the state "humano" has a handoff action
    const human = await conversation(s, contact);
    expect(human).toMatchObject({ state: 'humano', handoff: true });
    const replies = repliesOf(human.id).length;

    await say(s, contact, 'Alguém aí?');
    expect(repliesOf(human.id)).toHaveLength(replies);
    expect(await conversation(s, contact)).toMatchObject({ version: human.version });

    const back = await h.inject({
      method: 'POST',
      url: `/v1/conversations/${human.id}/handoff`,
      headers: { ...h.bearer(s.key), 'content-type': 'application/json' },
      payload: JSON.stringify({ to: 'bot' }),
    });
    expect(back.json()).toMatchObject({ handoff: false, state: 'humano' });

    const other = nextContact();
    await say(s, other, 'Oi');
    const second = await conversation(s, other);
    await h.inject({
      method: 'POST',
      url: `/v1/conversations/${second.id}/handoff`,
      headers: { ...h.bearer(s.key), 'content-type': 'application/json' },
      payload: JSON.stringify({ to: 'human' }),
    });
    await say(s, other, 'sim');
    expect(await conversation(s, other)).toMatchObject({ state: 'inicio', handoff: true });
    expect(await timers().getJob(timerJobId(second.id, 0))).toBeUndefined();
  });

  it('stores the messages of an instance without a bot and starts no conversation', async () => {
    const tenant = await h.createTenant();
    const instance = await h.createInstance(tenant.id);
    await h.whatsapp.createInstance({
      name: instance.providerName,
      webhookUrl: h.webhookUrl,
      webhookSecret: h.env.EVOLUTION_WEBHOOK_SECRET,
    });
    const id = newMessageId();
    await h.evolution.emitInboundText(instance.providerName, {
      from: nextContact(),
      text: 'Oi',
      id,
    });
    await waitFor(
      async () => (await h.prisma.outboxEvent.count({ where: { tenantId: tenant.id } })) === 1,
    );
    const row = await h.prisma.message.findFirstOrThrow({ where: { providerMessageId: id } });
    expect(row).toMatchObject({ direction: 'inbound', status: 'received', botPending: false });
    expect(await h.prisma.conversation.count({ where: { instanceId: instance.id } })).toBe(0);
  });
});

describe('inbound media', () => {
  it('stores the file in the media bucket and puts a signed URL in the event', async () => {
    const s = await setup();
    const id = newMessageId();
    const data = Buffer.from('fake-jpeg-bytes');
    await h.evolution.emitInboundMedia(s.instance.providerName, {
      from: nextContact(),
      id,
      mediaType: 'image',
      mimeType: 'image/jpeg',
      caption: 'Minha foto',
      data,
    });
    await waitForConsumed(s.instance.id, id);
    const message = await h.prisma.message.findFirstOrThrow({ where: { providerMessageId: id } });
    expect(message.content).toMatchObject({ type: 'media', media_status: 'stored' });
    const event = await h.prisma.outboxEvent.findFirstOrThrow({
      where: { tenantId: s.tenantId, type: 'message.received' },
    });
    const payload = event.payload as { media: { url: string; media_id: string }; text: string };
    expect(payload).toMatchObject({ type: 'media', text: 'Minha foto' });
    const media = await h.prisma.mediaObject.findUniqueOrThrow({
      where: { id: payload.media.media_id },
    });
    expect(media).toMatchObject({
      direction: 'inbound',
      contentType: 'image/jpeg',
      sizeBytes: data.length,
    });
    const download = await fetch(payload.media.url);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(data);
  });

  it('sends the event without media when the download fails', async () => {
    const s = await setup();
    const id = newMessageId();
    h.evolution.failNext({ route: /getBase64FromMediaMessage/, status: 400 });
    await h.evolution.emitInboundMedia(s.instance.providerName, {
      from: nextContact(),
      id,
      mediaType: 'document',
      mimeType: 'application/pdf',
    });
    await waitForConsumed(s.instance.id, id);
    const message = await h.prisma.message.findFirstOrThrow({ where: { providerMessageId: id } });
    expect(message.content).toMatchObject({ media_status: 'failed' });
    const event = await h.prisma.outboxEvent.findFirstOrThrow({
      where: { tenantId: s.tenantId, type: 'message.received' },
    });
    expect(event.payload).toMatchObject({ type: 'media' });
    expect((event.payload as Record<string, unknown>)['media']).toBeUndefined();
  });
});

describe('order of the events of one conversation', () => {
  const ordered: BotDefinitionInput = {
    initial_state: 's0',
    states: {
      s0: { transitions: [{ condition: { type: 'text', equals: ['a'] }, target: 's1' }] },
      s1: { transitions: [{ condition: { type: 'text', equals: ['b'] }, target: 's2' }] },
      s2: { transitions: [] },
    },
  };

  function event(s: Setup, contact: string, text: string) {
    return {
      kind: 'message.received' as const,
      instanceName: s.instance.providerName,
      dedupeKey: `test:${text}`,
      occurredAt: new Date(),
      providerMessageId: newMessageId(),
      from: contact,
      content: { type: 'text' as const, text },
    };
  }

  it('processes the earlier message first when the later job takes the lock first', async () => {
    const s = await setup(ordered);
    const contact = nextContact();
    await say(s, contact, 'start');
    const instance = await worker.get(InstanceResolver).byProviderName(s.instance.providerName);
    const a = event(s, contact, 'a');
    const b = event(s, contact, 'b');
    const t0 = Date.now();
    // Job A stored its row but did not reach the lock yet; job B runs completely first.
    await worker.get(InboundStoreService).store(instance!, a, new Date(t0));
    const handler = worker.get(MessageReceivedHandler);
    const context = (at: number) => ({
      jobId: 'j',
      attemptsMade: 0,
      rawEventId: null,
      receivedAt: new Date(at),
    });
    await handler.handle(b, context(t0 + 5));
    await handler.handle(a, context(t0));
    expect((await conversation(s, contact)).state).toBe('s2');
  });

  it('delays the job while the conversation lock is busy, without a failed attempt', async () => {
    const s = await setup(ordered);
    const contact = nextContact();
    const locks = h.get(DistributedLockService);
    const lock = await locks.acquire(conversationLockName(s.instance.id, contact), 20_000);
    const id = newMessageId();
    await h.evolution.emitInboundText(s.instance.providerName, {
      from: contact,
      text: 'start',
      id,
    });
    const inbound = h.get(QueuesService).get('inbound');
    const jobId = inboundJobId(`message.received:${s.instance.providerName}:${id}`);
    await waitFor(async () => (await inbound.getJobState(jobId)) === 'delayed');
    const delayed = await inbound.getJob(jobId);
    expect(delayed?.attemptsMade).toBe(0);
    expect(await h.prisma.message.findFirst({ where: { providerMessageId: id } })).toMatchObject({
      botPending: true,
    });
    await locks.release(lock!);
    await waitForConsumed(s.instance.id, id);
    expect((await conversation(s, contact)).state).toBe('s0');
  });

  it('keeps the order of two events processed in parallel by the worker', async () => {
    const s = await setup(ordered);
    const contact = nextContact();
    await say(s, contact, 'start');
    const idA = newMessageId();
    const idB = newMessageId();
    await h.evolution.emitInboundText(s.instance.providerName, {
      from: contact,
      text: 'a',
      id: idA,
    });
    await h.evolution.emitInboundText(s.instance.providerName, {
      from: contact,
      text: 'b',
      id: idB,
    });
    await waitForConsumed(s.instance.id, idA);
    await waitForConsumed(s.instance.id, idB);
    expect((await conversation(s, contact)).state).toBe('s2');
  });
});
