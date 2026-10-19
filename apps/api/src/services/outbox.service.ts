import { Injectable } from '@nestjs/common';
import { EVENT_DATA_SCHEMAS } from '@botcenter/contracts';
import type { EventDataMap, EventType } from '@botcenter/contracts';
import type { Prisma } from '../generated/prisma/client';
import type { TransactionClient } from '../prisma/prisma.service';

export interface OutboxInput<T extends EventType> {
  tenantId: string;
  type: T;
  /** The `data` of the webhook event. The contracts schema of `type` validates it. */
  payload: EventDataMap[T];
}

/** A payload that does not match the contracts. This is a programming error: the transaction rolls back. */
export class OutboxPayloadError extends Error {
  constructor(
    readonly type: EventType,
    readonly issues: string[],
  ) {
    super(`Invalid ${type} outbox payload: ${issues.join('; ')}`);
    this.name = 'OutboxPayloadError';
  }
}

/**
 * The transactional outbox. A state change and its events go in one transaction:
 *
 *   await prisma.$transaction(async (tx) => {
 *     await tx.message.update(...);
 *     await outbox.enqueue(tx, { tenantId, type: 'message.status', payload });
 *   });
 *
 * The webhooks slice moves the rows to the `webhooks` queue. The row id is the public event id.
 */
@Injectable()
export class OutboxService {
  async enqueue<T extends EventType>(
    tx: TransactionClient,
    input: OutboxInput<T>,
  ): Promise<string> {
    const result = EVENT_DATA_SCHEMAS[input.type].safeParse(input.payload);
    if (!result.success) {
      throw new OutboxPayloadError(
        input.type,
        result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      );
    }
    const row = await tx.outboxEvent.create({
      data: {
        tenantId: input.tenantId,
        type: input.type,
        payload: result.data as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    return row.id;
  }
}
