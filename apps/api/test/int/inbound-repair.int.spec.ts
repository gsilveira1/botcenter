import type { TestingModule } from '@nestjs/testing';
import type { BotDefinitionInput } from '@botcenter/contracts';
import { newMessageId } from '@botcenter/whatsapp-provider/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationsApiModule } from '../../src/conversations/conversations.module';
import { InboundStoreService } from '../../src/conversations/worker/inbound-store.service';
import { InstanceResolver } from '../../src/conversations/worker/instance-context';
import type { Instance } from '../../src/generated/prisma/client';
import { INBOUND_SWEEP_JOB, INBOUND_SWEEP_SCHEDULER } from '../../src/inbound/inbound.worker';
import { EXTERNAL_HTTP } from '../../src/ports/external-http.port';
import { QueuesService } from '../../src/queues/queues.service';
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
