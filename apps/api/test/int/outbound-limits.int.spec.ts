import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Instance, Tenant } from '../../src/generated/prisma/client';
import { MessagesApiModule } from '../../src/messages/messages.module';
import { OUTBOUND_MESSAGES } from '../../src/ports/outbound-messages.port';
import type { OutboundMessagesPort } from '../../src/ports/outbound-messages.port';
import { QueuesService } from '../../src/queues/queues.service';
import { TestHarness } from '../support/harness';

/**
 * SEC-04 (outbound part): an instance has at most `OUTBOUND_MAX_QUEUED_PER_INSTANCE` queued rows. The
 * harness has no worker, so the rows stay `queued`.
 */
let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start({
    modules: [MessagesApiModule],
    env: { OUTBOUND_MAX_QUEUED_PER_INSTANCE: '2' },
  });
});

afterAll(async () => {
  await h?.close();
});

interface Fixture {
  tenant: Tenant;
  instance: Instance;
  key: string;
}

async function fixture(tenant?: Tenant): Promise<Fixture> {
  const owner = tenant ?? (await h.createTenant());
  const instance = await h.createInstance(owner.id, { status: 'connecting' });
  const { key } = await h.createApiKey({ tenantId: owner.id, scopes: ['messages:send'] });
  return { tenant: owner, instance, key };
}

function send(f: Fixture, to = '5511987654321') {
  return h.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: { ...h.bearer(f.key), 'content-type': 'application/json' },
    payload: JSON.stringify({ instance_id: f.instance.id, to, type: 'text', text: 'Oi' }),
  });
}

async function reply(f: Fixture, to = '5511912345678'): Promise<string> {
  const port = h.get<OutboundMessagesPort>(OUTBOUND_MESSAGES);
  const { messageId } = await h.prisma.$transaction(async (tx) =>
    port.createInTx(tx as never, {
      tenantId: f.tenant.id,
      instanceId: f.instance.id,
      to,
      content: { type: 'text', text: 'Resposta' },
      priority: 'reply',
    }),
  );
  await port.dispatch([{ tenantId: f.tenant.id, messageId, instanceId: f.instance.id }]);
  return messageId;
}

describe('queued rows of one instance (SEC-04)', () => {
  it('answers 429 QUOTA_EXCEEDED above the limit, and the daily quota does not count it', async () => {
    const f = await fixture();
    expect((await send(f)).statusCode).toBe(202);
    expect((await send(f)).statusCode).toBe(202);
    const refused = await send(f);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(refused.headers['retry-after']).toBe('60');
    expect(await h.prisma.message.count({ where: { instanceId: f.instance.id } })).toBe(2);
    // An other instance of the same tenant is not affected.
    const other = await fixture(f.tenant);
    expect((await send(other)).statusCode).toBe(202);
  });

  it('refuses a bot reply above the limit without a rollback of the conversation step', async () => {
    const f = await fixture();
    await send(f);
    await send(f);
    const id = await reply(f);
    const row = await h.prisma.message.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'failed', failureReason: 'instance_queue_full' });
    const events = await h.prisma.outboxEvent.findMany({ where: { type: 'message.status' } });
    expect(events.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({
        message_id: id,
        status: 'failed',
        failure_reason: 'instance_queue_full',
      }),
    );
    // The refused reply gets no job.
    expect(await h.get(QueuesService).get('outbound').getJob(id)).toBeUndefined();
  });
});
