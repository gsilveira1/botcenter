import type { TestingModule } from '@nestjs/testing';
import type { BotDefinitionInput } from '@botcenter/contracts';
import { newMessageId } from '@botcenter/whatsapp-provider/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationsApiModule } from '../../src/conversations/conversations.module';
import { ConversationCacheService } from '../../src/conversations/conversation-cache.service';
import { contactKey } from '../../src/conversations/conversation-keys';
import { toConversationRecord } from '../../src/conversations/conversation-record';
import { InboundStoreService } from '../../src/conversations/worker/inbound-store.service';
import { timerJobId } from '@botcenter/engine';
import { InstanceResolver } from '../../src/conversations/worker/instance-context';
import { MessageReceivedHandler } from '../../src/conversations/worker/message-received.handler';
import type { Instance } from '../../src/generated/prisma/client';
import { INBOUND_SWEEP_JOB, INBOUND_SWEEP_SCHEDULER } from '../../src/inbound/inbound.worker';
import { EXTERNAL_HTTP } from '../../src/ports/external-http.port';
import { QueuesService } from '../../src/queues/queues.service';
import { redisKeys } from '../../src/redis/redis-keys';
import { FakeExternalHttp } from '../support/conversation-ports';
import { TestHarness } from '../support/harness';
import { waitFor } from '../support/wait-for';

/**
 * Regression tests of the repair paths of the inbound runtime (wave 3, slice `inbound-runtime`).
 */

let h: TestHarness;
let worker: TestingModule;

beforeAll(async () => {
  h = await TestHarness.start({ modules: [ConversationsApiModule] });
  worker = await h.startWorker([], undefined, [
    { provide: EXTERNAL_HTTP, useValue: new FakeExternalHttp() },
  ]);
});

afterAll(async () => {
  await h?.close();
});

const twoStates: BotDefinitionInput = {
  initial_state: 's0',
  states: {
    s0: {
      on_enter: [{ type: 'send_message', message: { type: 'text', text: 'Oi' } }],
      transitions: [{ condition: { type: 'text', equals: ['a'] }, target: 's1' }],
    },
    s1: { transitions: [] },
  },
};

interface Setup {
  tenantId: string;
  instance: Instance;
  key: string;
}

let contactSeq = 0;
const nextContact = () => `55119877${String(5000 + (contactSeq += 1)).padStart(5, '0')}`;

async function setup(definition: BotDefinitionInput = twoStates): Promise<Setup> {
  const tenant = await h.createTenant();
  const instance = await h.createInstance(tenant.id, { status: 'connected' });
  const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['bots:write'] });
  const put = await h.inject({
    method: 'PUT',
    url: '/v1/bots/repair',
    headers: { ...h.bearer(key), 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Repair', definition, instance_ids: [instance.id] }),
  });
  expect(put.statusCode).toBe(200);
  return { tenantId: tenant.id, instance, key };
}

function textEvent(s: Setup, contact: string, text: string) {
  return {
    kind: 'message.received' as const,
    instanceName: s.instance.providerName,
    dedupeKey: `test:${newMessageId()}`,
    occurredAt: new Date(),
    providerMessageId: newMessageId(),
    from: contact,
    content: { type: 'text' as const, text },
  };
}

const timed: BotDefinitionInput = {
  initial_state: 'espera',
  states: {
    espera: {
      timeout: { after_seconds: 600, target: 'lembrete' },
      transitions: [{ condition: { type: 'text', equals: ['a'] }, target: 'fim' }],
    },
    lembrete: { transitions: [] },
    fim: { transitions: [], final: true },
  },
};

/** Runs the inbound handler for one text message, like the inbound worker. */
async function say(s: Setup, contact: string, text: string): Promise<void> {
  await worker.get(MessageReceivedHandler).handle(textEvent(s, contact, text), {
    jobId: 'j',
    attemptsMade: 0,
    rawEventId: null,
    receivedAt: new Date(),
  });
}

const timers = () => h.get(QueuesService).get('timers');

function conversationOf(s: Setup, contact: string) {
  return h.prisma.conversation.findUnique({
    where: { instanceId_contact: { instanceId: s.instance.id, contact } },
  });
}

async function runSweep(): Promise<void> {
  const inbound = h.get(QueuesService).get('inbound');
  const job = await inbound.add(INBOUND_SWEEP_JOB, { task: 'sweep-inbound' }, { attempts: 1 });
  await waitFor(async () => (await job.isCompleted()) || (await job.isFailed()));
  expect(await job.isFailed()).toBe(false);
}

describe('lost inbound work (ARCH-01)', () => {
  it('upserts the sweep-inbound job scheduler in the inbound queue', async () => {
    const schedulers = await h.get(QueuesService).get('inbound').getJobSchedulers();
    expect(schedulers.map((scheduler) => scheduler.key)).toContain(INBOUND_SWEEP_SCHEDULER);
  });

  it('drains a botPending row that no job drained (the drain failed after the store)', async () => {
    const s = await setup();
    const contact = nextContact();
    const instance = await worker.get(InstanceResolver).byProviderName(s.instance.providerName);
    // The job stored the row, then PostgreSQL failed before the drain, and the job failed for ever.
    const stored = await worker
      .get(InboundStoreService)
      .store(instance!, textEvent(s, contact, 'Oi'), new Date(Date.now() - 2 * 60_000));
    expect(stored.botPending).toBe(true);
    expect(await conversationOf(s, contact)).toBeNull();

    await runSweep();

    const row = await h.prisma.message.findUniqueOrThrow({ where: { id: stored.messageId } });
    expect(row.botPending).toBe(false);
    expect(await conversationOf(s, contact)).toMatchObject({ state: 's0' });
  });

  it('leaves a young botPending row to its running job', async () => {
    const s = await setup();
    const contact = nextContact();
    const instance = await worker.get(InstanceResolver).byProviderName(s.instance.providerName);
    const stored = await worker
      .get(InboundStoreService)
      .store(instance!, textEvent(s, contact, 'Oi'), new Date());

    await runSweep();

    const row = await h.prisma.message.findUniqueOrThrow({ where: { id: stored.messageId } });
    expect(row.botPending).toBe(true);
  });
});

describe('lost state timer (ARCH-08)', () => {
  it('stores the fire time with the step and adds a lost timer job again', async () => {
    const s = await setup(timed);
    const contact = nextContact();
    await say(s, contact, 'Oi');
    const started = (await conversationOf(s, contact))!;
    expect(started).toMatchObject({ state: 'espera', version: 0 });
    expect(started.timerFireAt!.getTime()).toBeGreaterThan(Date.now() + 500_000);

    // Redis lost the job, and the fire time passed.
    await timers().remove(timerJobId(started.id, 0));
    await h.prisma.conversation.update({
      where: { id: started.id },
      data: { timerFireAt: new Date(Date.now() - 5 * 60_000) },
    });

    await runSweep();

    await waitFor(async () => (await conversationOf(s, contact))?.state === 'lembrete');
    const reminded = (await conversationOf(s, contact))!;
    expect(reminded.version).toBe(1);
    // The state `lembrete` has no timeout: nothing is armed.
    expect(reminded.timerFireAt).toBeNull();
  });

  it('clears the fire time when the timer ran and changed nothing', async () => {
    const s = await setup(timed);
    const contact = nextContact();
    await say(s, contact, 'Oi');
    const started = (await conversationOf(s, contact))!;
    const job = await timers().getJob(timerJobId(started.id, 0));
    // A handoff runs at the same time as the timer: the timer is stale and completes as a no-op.
    await h.prisma.conversation.update({ where: { id: started.id }, data: { handoff: true } });
    await job!.promote();
    await waitFor(async () => (await job!.isCompleted()) || (await job!.isFailed()));
    await h.prisma.conversation.update({
      where: { id: started.id },
      data: { handoff: false, timerFireAt: new Date(Date.now() - 5 * 60_000) },
    });

    await runSweep();

    expect((await conversationOf(s, contact))!.timerFireAt).toBeNull();
  });
});

describe('stale hot cache with handoff (ARCH-09)', () => {
  function handoff(s: Setup, id: string, to: 'human' | 'bot') {
    return h.inject({
      method: 'POST',
      url: `/v1/conversations/${id}/handoff`,
      headers: { ...h.bearer(s.key), 'content-type': 'application/json' },
      payload: JSON.stringify({ to }),
    });
  }

  it('keeps a newer cached version when an older record arrives late', async () => {
    const s = await setup(timed);
    const contact = nextContact();
    await say(s, contact, 'Oi');
    const row = (await conversationOf(s, contact))!;
    expect((await handoff(s, row.id, 'human')).statusCode).toBe(200);
    expect((await handoff(s, row.id, 'bot')).statusCode).toBe(200);

    // A worker read PostgreSQL before the handoff to the bot and writes its old record now.
    const cache = worker.get(ConversationCacheService);
    await cache.set(toConversationRecord({ ...row, handoff: true, version: 1 }));

    const cached = await cache.get(s.instance.id, contact);
    expect(cached).toMatchObject({ handoff: false, version: 2 });
  });

  it('runs the bot when the cache keeps handoff = true after the handoff to the bot', async () => {
    const s = await setup(timed);
    const contact = nextContact();
    await say(s, contact, 'Oi');
    const row = (await conversationOf(s, contact))!;
    await handoff(s, row.id, 'human');
    await handoff(s, row.id, 'bot');
    // Redis refused the write and the delete of the API: the old entry stays for 1 h.
    const stale = toConversationRecord({ ...row, handoff: true, version: 1 });
    await h.redis.set(
      redisKeys.conversation(s.instance.id, contactKey(contact)),
      JSON.stringify(stale),
      'EX',
      3_600,
    );

    await say(s, contact, 'a');

    expect(await conversationOf(s, contact)).toMatchObject({ state: 'fim', handoff: false });
  });
});
