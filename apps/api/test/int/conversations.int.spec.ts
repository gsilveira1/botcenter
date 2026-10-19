import type { BotDefinitionInput } from '@botcenter/contracts';
import { timerJobId } from '@botcenter/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationsApiModule } from '../../src/conversations/conversations.module';
import { TIMER_JOB_NAME } from '../../src/conversations/conversation-timers.service';
import { QueuesService } from '../../src/queues/queues.service';
import { TestHarness } from '../support/harness';

let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start({ modules: [ConversationsApiModule] });
});

afterAll(async () => {
  await h?.close();
});

const definition: BotDefinitionInput = {
  initial_state: 'espera',
  variables: { nome: '' },
  states: {
    espera: {
      transitions: [{ condition: { type: 'any' }, target: 'fim' }],
      timeout: { after_seconds: 600, target: 'fim' },
    },
    fim: { final: true, transitions: [] },
  },
};

async function setup() {
  const tenant = await h.createTenant();
  const instance = await h.createInstance(tenant.id);
  const { key, prefix } = await h.createApiKey({ tenantId: tenant.id, scopes: ['bots:write'] });
  const put = await h.inject({
    method: 'PUT',
    url: '/v1/bots/atendimento',
    headers: { ...h.bearer(key), 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Atendimento', definition, instance_ids: [instance.id] }),
  });
  expect(put.statusCode).toBe(200);
  const bot = await h.prisma.bot.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const conversation = await h.prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      instanceId: instance.id,
      contact: '5511987654321',
      botId: bot.id,
      botVersion: 1,
      state: 'espera',
      variables: { nome: 'Ana' },
      version: 3,
    },
  });
  return { tenant, instance, key, prefix, bot, conversation };
}

const timers = () => h.get(QueuesService).get('timers');

function handoff(key: string, id: string, to: 'human' | 'bot') {
  return h.inject({
    method: 'POST',
    url: `/v1/conversations/${id}/handoff`,
    headers: { ...h.bearer(key), 'content-type': 'application/json' },
    payload: JSON.stringify({ to }),
  });
}

describe('GET /v1/conversations/{id}', () => {
  it('returns the state, the variables, and the last 50 transitions (most recent first)', async () => {
    const { tenant, key, conversation } = await setup();
    const base = Date.UTC(2026, 9, 19, 12, 0, 0);
    await h.prisma.conversationTransition.createMany({
      data: Array.from({ length: 55 }, (_, index) => ({
        tenantId: tenant.id,
        conversationId: conversation.id,
        fromState: index === 0 ? null : 'espera',
        toState: 'espera',
        trigger: index === 0 ? ('start' as const) : ('message' as const),
        createdAt: new Date(base + index * 1000),
      })),
    });
    const response = await h.inject({
      method: 'GET',
      url: `/v1/conversations/${conversation.id}`,
      headers: h.bearer(key),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      id: conversation.id,
      bot_id: 'atendimento',
      bot_version: 1,
      state: 'espera',
      variables: { nome: 'Ana' },
      handoff: false,
      contact: '5511987654321',
    });
    expect(body.transitions).toHaveLength(50);
    expect(body.transitions[0].at).toBe(new Date(base + 54_000).toISOString());
  });

  it('answers 404 for a key of another tenant and 403 outside the instance list of the key', async () => {
    const a = await setup();
    const b = await setup();
    const foreign = await h.inject({
      method: 'GET',
      url: `/v1/conversations/${a.conversation.id}`,
      headers: h.bearer(b.key),
    });
    expect(foreign.statusCode).toBe(404);
    expect((await handoff(b.key, a.conversation.id, 'human')).statusCode).toBe(404);

    const other = await h.createInstance(a.tenant.id);
    const restricted = await h.createApiKey({
      tenantId: a.tenant.id,
      scopes: ['bots:write'],
      instanceIds: [other.id],
    });
    const refused = await h.inject({
      method: 'GET',
      url: `/v1/conversations/${a.conversation.id}`,
      headers: h.bearer(restricted.key),
    });
    expect(refused.statusCode).toBe(403);
    expect((await handoff(restricted.key, a.conversation.id, 'human')).statusCode).toBe(403);
    const row = await h.prisma.conversation.findUniqueOrThrow({ where: { id: a.conversation.id } });
    expect(row).toMatchObject({ handoff: false, version: 3 });
  });
});

describe('POST /v1/conversations/{id}/handoff', () => {
  it('moves the conversation to a human: flag, version, transition, event, audit, timer removed', async () => {
    const { tenant, key, prefix, conversation } = await setup();
    const pending = timerJobId(conversation.id, 3);
    await timers().add(
      TIMER_JOB_NAME,
      {
        tenantId: tenant.id,
        conversationId: conversation.id,
        state: 'espera',
        conversationVersion: 3,
      },
      { jobId: pending, delay: 600_000 },
    );

    const response = await handoff(key, conversation.id, 'human');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ handoff: true, state: 'espera' });
    expect(response.json().transitions[0]).toMatchObject({
      from_state: 'espera',
      to_state: 'espera',
      trigger: 'handoff',
    });
    const row = await h.prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(row).toMatchObject({ handoff: true, version: 4 });
    expect(await timers().getJob(pending)).toBeUndefined();

    const events = await h.prisma.outboxEvent.findMany({
      where: { tenantId: tenant.id, type: 'conversation.transitioned' },
    });
    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        conversation_id: conversation.id,
        trigger: 'handoff',
        handoff: true,
        bot_id: 'atendimento',
      }),
    ]);
    const audit = await h.prisma.auditLog.findFirstOrThrow({
      where: { tenantId: tenant.id, action: 'conversation.handoff.human' },
    });
    expect(audit).toMatchObject({ actor: `api_key:${prefix}`, targetId: conversation.id });

    // The same target again changes nothing.
    const again = await handoff(key, conversation.id, 'human');
    expect(again.statusCode).toBe(200);
    expect(
      await h.prisma.conversationTransition.count({ where: { conversationId: conversation.id } }),
    ).toBe(1);
  });

  it('gives the conversation back to the bot and arms the timer of the state with the new version', async () => {
    const { tenant, key, conversation } = await setup();
    await handoff(key, conversation.id, 'human');
    const response = await handoff(key, conversation.id, 'bot');
    expect(response.statusCode).toBe(200);
    expect(response.json().handoff).toBe(false);
    const row = await h.prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(row.version).toBe(5);
    const job = await timers().getJob(timerJobId(conversation.id, 5));
    expect(job?.data).toEqual({
      tenantId: tenant.id,
      conversationId: conversation.id,
      state: 'espera',
      conversationVersion: 5,
    });
    expect(await job?.isDelayed()).toBe(true);
    expect(
      await h.prisma.auditLog.count({
        where: { tenantId: tenant.id, action: 'conversation.handoff.bot' },
      }),
    ).toBe(1);
  });

  it('refuses a bad target (400)', async () => {
    const { key, conversation } = await setup();
    const response = await h.inject({
      method: 'POST',
      url: `/v1/conversations/${conversation.id}/handoff`,
      headers: { ...h.bearer(key), 'content-type': 'application/json' },
      payload: JSON.stringify({ to: 'agent' }),
    });
    expect(response.statusCode).toBe(400);
  });
});
