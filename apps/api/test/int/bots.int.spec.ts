import type { BotDefinitionInput } from '@botcenter/contracts';
import { personalTrainerOnboarding } from '@botcenter/engine/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationsApiModule } from '../../src/conversations/conversations.module';
import { TestHarness } from '../support/harness';

let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start({ modules: [ConversationsApiModule] });
});

afterAll(async () => {
  await h?.close();
});

async function setup(options: { instances?: number } = {}) {
  const tenant = await h.createTenant();
  const instances = await Promise.all(
    Array.from({ length: options.instances ?? 1 }, () => h.createInstance(tenant.id)),
  );
  const { key, prefix } = await h.createApiKey({ tenantId: tenant.id, scopes: ['bots:write'] });
  return { tenant, instances, key, prefix };
}

function putBot(
  key: string,
  slug: string,
  body: { name?: string; definition?: unknown; instance_ids?: string[] },
) {
  return h.inject({
    method: 'PUT',
    url: `/v1/bots/${slug}`,
    headers: { ...h.bearer(key), 'content-type': 'application/json' },
    payload: JSON.stringify({
      name: body.name ?? 'Onboarding',
      definition: body.definition ?? personalTrainerOnboarding,
      instance_ids: body.instance_ids ?? [],
    }),
  });
}

const simpleBot = (text: string): BotDefinitionInput => ({
  initial_state: 'inicio',
  states: {
    inicio: {
      on_enter: [{ type: 'send_message', message: { type: 'text', text } }],
      transitions: [{ condition: { type: 'any' }, target: 'fim' }],
    },
    fim: { final: true, transitions: [] },
  },
});

describe('PUT /v1/bots/{id}', () => {
  it('creates the bot with version 1, binds the instances, and writes an audit row', async () => {
    const { tenant, instances, key, prefix } = await setup({ instances: 2 });
    const ids = instances.map((instance) => instance.id).sort();
    const response = await putBot(key, 'onboarding', { instance_ids: ids });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'onboarding',
      name: 'Onboarding',
      version: 1,
      instance_ids: ids,
    });
    const bot = await h.prisma.bot.findFirstOrThrow({
      where: { tenantId: tenant.id, slug: 'onboarding' },
      include: { versions: true, instances: true },
    });
    expect(bot.versions).toHaveLength(1);
    // The stored definition is the parsed output (with the defaults).
    expect(bot.versions[0]?.definition).toMatchObject({
      states: { inicio: { final: false } },
    });
    expect(bot.instances.map((instance) => instance.id).sort()).toEqual(ids);
    const audit = await h.prisma.auditLog.findFirstOrThrow({
      where: { tenantId: tenant.id, action: 'bot.put' },
    });
    expect(audit).toMatchObject({ actor: `api_key:${prefix}`, targetId: bot.id });
  });

  it('keeps the version for the same definition and publishes a new version for a change', async () => {
    const { tenant, key } = await setup();
    expect((await putBot(key, 'b1', { definition: simpleBot('Oi') })).json().version).toBe(1);
    const same = await putBot(key, 'b1', { name: 'Renamed', definition: simpleBot('Oi') });
    expect(same.json()).toMatchObject({ version: 1, name: 'Renamed' });
    const changed = await putBot(key, 'b1', { definition: simpleBot('Olá') });
    expect(changed.json().version).toBe(2);
    expect(
      await h.prisma.botVersion.count({ where: { tenantId: tenant.id, bot: { slug: 'b1' } } }),
    ).toBe(2);
  });

  it('answers 422 BOT_DEFINITION_INVALID with one error for each path', async () => {
    const { key } = await setup();
    const definition = {
      initial_state: 'inicio',
      states: {
        inicio: {
          transitions: [
            { condition: { type: 'regex', pattern: '(?=a)a' }, target: 'fim' },
            { condition: { type: 'any' }, target: 'nao_existe' },
          ],
        },
        fim: { final: true, transitions: [] },
      },
    };
    const contract = await putBot(key, 'bad', { definition });
    expect(contract.statusCode).toBe(422);
    expect(contract.json()).toMatchObject({
      code: 'BOT_DEFINITION_INVALID',
      errors: [
        {
          path: 'definition.states.inicio.transitions.1.target',
          message: 'State "nao_existe" does not exist',
        },
      ],
    });

    // The contract accepts a lookahead; the engine (RE2) refuses it.
    definition.states.inicio.transitions[1] = { condition: { type: 'any' }, target: 'fim' };
    const engine = await putBot(key, 'bad', { definition });
    expect(engine.statusCode).toBe(422);
    expect(engine.json().errors).toEqual([
      {
        path: 'definition.states.inicio.transitions.0.condition.pattern',
        message: expect.stringContaining('RE2'),
      },
    ]);
    expect(await h.prisma.bot.count({ where: { slug: 'bad' } })).toBe(0);
  });

  it('answers 400 for a body without a definition or with a bad slug', async () => {
    const { key } = await setup();
    const missing = await h.inject({
      method: 'PUT',
      url: '/v1/bots/b2',
      headers: { ...h.bearer(key), 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x', instance_ids: [] }),
    });
    expect(missing.statusCode).toBe(400);
    expect((await putBot(key, 'Bad_Slug', {})).statusCode).toBe(400);
  });

  it('refuses an instance of another tenant (404) and an instance outside the key list (403)', async () => {
    const a = await setup();
    const b = await setup();
    const foreign = await putBot(a.key, 'x', { instance_ids: [b.instances[0]!.id] });
    expect(foreign.statusCode).toBe(404);
    expect(
      await h.prisma.instance.findUniqueOrThrow({ where: { id: b.instances[0]!.id } }),
    ).toMatchObject({
      botId: null,
    });

    const other = await h.createInstance(a.tenant.id);
    const restricted = await h.createApiKey({
      tenantId: a.tenant.id,
      scopes: ['bots:write'],
      instanceIds: [a.instances[0]!.id],
    });
    const refused = await putBot(restricted.key, 'x', { instance_ids: [other.id] });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('INSTANCE_NOT_ALLOWED');
  });

  it('does not let a key with an instance list unbind the other instances of the bot', async () => {
    const { tenant, instances, key } = await setup({ instances: 2 });
    const [first, second] = instances as [(typeof instances)[0], (typeof instances)[0]];
    await putBot(key, 'shared', { instance_ids: [first.id, second.id] });
    const restricted = await h.createApiKey({
      tenantId: tenant.id,
      scopes: ['bots:write'],
      instanceIds: [first.id],
    });
    const response = await putBot(restricted.key, 'shared', { instance_ids: [] });
    expect(response.statusCode).toBe(200);
    expect(response.json().instance_ids).toEqual([]);
    const rows = await h.prisma.instance.findMany({ where: { tenantId: tenant.id } });
    expect(rows.find((row) => row.id === first.id)?.botId).toBeNull();
    expect(rows.find((row) => row.id === second.id)?.botId).not.toBeNull();
  });

  it('moves an instance from another bot to this bot', async () => {
    const { tenant, instances, key } = await setup();
    const instance = instances[0]!;
    await putBot(key, 'old', { definition: simpleBot('a'), instance_ids: [instance.id] });
    const response = await putBot(key, 'new', {
      definition: simpleBot('b'),
      instance_ids: [instance.id],
    });
    expect(response.json().instance_ids).toEqual([instance.id]);
    const old = await h.inject({ method: 'GET', url: '/v1/bots/old', headers: h.bearer(key) });
    expect(old.json().instance_ids).toEqual([]);
    const audit = await h.prisma.auditLog.findFirstOrThrow({
      where: {
        tenantId: tenant.id,
        action: 'bot.put',
        metadata: { path: ['slug'], equals: 'new' },
      },
    });
    expect((audit.metadata as { moved_from_bot_ids: string[] }).moved_from_bot_ids).toHaveLength(1);
  });
});

describe('GET /v1/bots/{id}', () => {
  it('reads the bot of the tenant and answers 404 for another tenant', async () => {
    const a = await setup();
    const b = await setup();
    await putBot(a.key, 'mine', { definition: simpleBot('a') });
    const own = await h.inject({ method: 'GET', url: '/v1/bots/mine', headers: h.bearer(a.key) });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ id: 'mine', version: 1 });
    const foreign = await h.inject({
      method: 'GET',
      url: '/v1/bots/mine',
      headers: h.bearer(b.key),
    });
    expect(foreign.statusCode).toBe(404);

    // The same slug under tenant B is a different bot: tenant A's bot does not change.
    expect((await putBot(b.key, 'mine', { definition: simpleBot('b') })).json().version).toBe(1);
    await putBot(b.key, 'mine', { definition: simpleBot('c') });
    const after = await h.inject({ method: 'GET', url: '/v1/bots/mine', headers: h.bearer(a.key) });
    expect(after.json().version).toBe(1);
    const versions = await h.prisma.botVersion.findMany({
      where: { tenantId: a.tenant.id, bot: { slug: 'mine' } },
    });
    expect(versions).toHaveLength(1);
  });

  it('refuses a key without the bots:write scope', async () => {
    const { tenant } = await setup();
    const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['messages:send'] });
    const response = await h.inject({ method: 'GET', url: '/v1/bots/x', headers: h.bearer(key) });
    expect(response.statusCode).toBe(403);
  });
});
