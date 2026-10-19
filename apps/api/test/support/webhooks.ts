import { randomUUID } from 'node:crypto';
import type { MessageStatusData } from '@botcenter/contracts';
import type { DnsResolver, ResolvedAddress } from '../../src/external-http/ssrf-guard';
import type { PrismaClient, WebhookDeliveryStatus } from '../../src/generated/prisma/client';

/** A public address for the fake DNS answers (no test connects to it). */
export const PUBLIC_ADDRESS: ResolvedAddress = { address: '93.184.215.14', family: 4 };

/**
 * A DNS resolver with fixed answers. A missing name gives `ENOTFOUND`, like the system resolver.
 * Integration tests replace `DNS_RESOLVER` with it, so no test needs the network.
 */
export function fakeDns(answers: Record<string, ResolvedAddress[]>): DnsResolver {
  return {
    async resolve(hostname) {
      const answer = answers[hostname];
      if (!answer) {
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
      }
      return answer;
    },
  };
}

/** A webhook event body of the outbox (`message.status`). */
export function messageStatusData(
  status: MessageStatusData['status'] = 'delivered',
): MessageStatusData {
  return {
    instance_id: randomUUID(),
    external_ref: 'trainer-1',
    message_id: randomUUID(),
    status,
    failure_reason: null,
  };
}

export interface DeliveryFixture {
  tenantId: string;
  subscriptionId: string;
  status?: WebhookDeliveryStatus;
  attempts?: number;
  nextAttemptAt?: Date | null;
  createdAt?: Date;
  lastError?: string | null;
}

/** Writes one delivery row directly (the list and redelivery tests). */
export async function insertDelivery(prisma: PrismaClient, fixture: DeliveryFixture) {
  const eventId = randomUUID();
  return prisma.webhookDelivery.create({
    data: {
      tenantId: fixture.tenantId,
      subscriptionId: fixture.subscriptionId,
      eventId,
      eventType: 'message.status',
      payload: {
        id: eventId,
        type: 'message.status',
        created_at: new Date().toISOString(),
        data: messageStatusData(),
      },
      status: fixture.status ?? 'pending',
      attempts: fixture.attempts ?? 0,
      nextAttemptAt: fixture.nextAttemptAt === undefined ? new Date() : fixture.nextAttemptAt,
      lastError: fixture.lastError ?? null,
      ...(fixture.createdAt ? { createdAt: fixture.createdAt } : {}),
    },
  });
}
