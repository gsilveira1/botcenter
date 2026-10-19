import { setTimeout as sleep } from 'node:timers/promises';
import type { SendMessageInput } from '@botcenter/whatsapp-provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Instance, Tenant } from '../../src/generated/prisma/client';
import { MessagesApiModule, MessagesWorkerModule } from '../../src/messages/messages.module';
import { OUTBOUND_MESSAGES } from '../../src/ports/outbound-messages.port';
import type {
  OutboundMessageInput,
  OutboundMessagesPort,
} from '../../src/ports/outbound-messages.port';
import { TestHarness } from '../support/harness';
import { waitFor } from '../support/wait-for';

/**
 * ARCH-02: the bot replies of one contact go out in the order of the rows. The fake provider holds each
 * send for its typing delay, like Evolution. Without the order rule, the short reply goes out first.
 */
const LONG_AGO = new Date('2026-01-01T00:00:00Z');

let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start({ modules: [MessagesApiModule] });
  await h.startWorker([MessagesWorkerModule]);
  // Like Evolution: the provider holds the request for the typing delay, then sends.
  const provider = h.provider;
  const send = provider.sendMessage.bind(provider);
  provider.sendMessage = async (name: string, input: SendMessageInput) => {
    await sleep(input.typingDelayMs ?? 0);
    return send(name, input);
  };
});

afterAll(async () => {
  await h?.close();
});

interface Fixture {
  tenant: Tenant;
  instance: Instance;
}

async function fixture(): Promise<Fixture> {
  const tenant = await h.createTenant();
  const instance = await h.createInstance(tenant.id, {
    status: 'connected',
    firstConnectedAt: LONG_AGO,
    rateLimitPerMinute: 600,
  });
  await h.provider.createInstance({
    name: instance.providerName,
    webhookUrl: 'x',
    webhookSecret: 's',
  });
  h.provider.setState(instance.providerName, 'connected');
  return { tenant, instance };
}

/** Writes the replies of one bot step in one transaction (as the conversation writer does), then dispatches them. */
async function replies(
  f: Fixture,
  contact: string,
  items: ReadonlyArray<Pick<OutboundMessageInput, 'content' | 'typingDelayMs'>>,
): Promise<string[]> {
  const port = h.get<OutboundMessagesPort>(OUTBOUND_MESSAGES);
  const ids = await h.prisma.$transaction(async (tx) => {
    const written: string[] = [];
    for (const item of items) {
      const { messageId } = await port.createInTx(tx as never, {
        tenantId: f.tenant.id,
        instanceId: f.instance.id,
        to: contact,
        priority: 'reply',
        ...item,
      });
      written.push(messageId);
    }
    return written;
  });
  await port.dispatch(
    ids.map((messageId) => ({ tenantId: f.tenant.id, messageId, instanceId: f.instance.id })),
  );
  return ids;
}

function sentTexts(f: Fixture, contact: string): string[] {
  return h.provider
    .sentTo(f.instance.providerName)
    .filter((send) => send.input.to === contact)
    .map((send) => (send.input.content as { text: string }).text);
}

async function allSent(ids: readonly string[]): Promise<boolean> {
  const rows = await h.prisma.message.findMany({ where: { id: { in: [...ids] } } });
  return rows.every((row) => row.status === 'sent');
}

describe('outbound order of one contact (ARCH-02)', () => {
  it('sends a long reply before the short reply that follows it', async () => {
    const f = await fixture();
    const contact = '5511987650001';
    const ids = await replies(f, contact, [
      {
        content: {
          type: 'text',
          text: 'Obrigado, Ana! Agora vou perguntar sobre o seu objetivo e a sua rotina de treinos.',
        },
        typingDelayMs: 2_700,
      },
      { content: { type: 'text', text: '1. Hipertrofia\n2. Emagrecimento' }, typingDelayMs: 800 },
    ]);
    await waitFor(() => allSent(ids), 20_000);
    expect(sentTexts(f, contact)).toEqual([
      'Obrigado, Ana! Agora vou perguntar sobre o seu objetivo e a sua rotina de treinos.',
      '1. Hipertrofia\n2. Emagrecimento',
    ]);
  });

  it('keeps the order of three replies, and does not block the replies of an other contact', async () => {
    const f = await fixture();
    const first = '5511987650002';
    const other = '5511987650003';
    const ids = await replies(f, first, [
      { content: { type: 'text', text: 'A' }, typingDelayMs: 1_500 },
      { content: { type: 'text', text: 'B' }, typingDelayMs: 900 },
      { content: { type: 'text', text: 'C' }, typingDelayMs: 100 },
    ]);
    const otherIds = await replies(f, other, [
      { content: { type: 'text', text: 'X' }, typingDelayMs: 100 },
    ]);
    // The reply to the other contact does not wait for the three replies of the first contact.
    await waitFor(() => allSent(otherIds), 5_000);
    expect(await allSent(ids)).toBe(false);
    await waitFor(() => allSent(ids), 20_000);
    expect(sentTexts(f, first)).toEqual(['A', 'B', 'C']);
  });
});
