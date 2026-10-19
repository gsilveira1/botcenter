import { Injectable } from '@nestjs/common';
import { MaskedPhoneNumber } from '@botcenter/contracts';
import type { InstanceStatus } from '@botcenter/contracts';
import { Prisma } from '../generated/prisma/client';
import { getLogger } from '../logging/logger';
import { maskPhone } from '../logging/mask';
import { PrismaService } from '../prisma/prisma.service';
import type { TransactionClient } from '../prisma/prisma.service';
import { AlertService } from '../services/alert.service';
import { OutboxService } from '../services/outbox.service';
import { ConnectChannelService } from './connect-channel.service';
import { isStreamFinalStatus, planTransition } from './instance-status';

/** How the service finds the instance: by id in a tenant (API) or by the provider name (webhook). */
export type InstanceLookup = { id: string; tenantId: string } | { providerName: string };

const SUBJECT_SELECT = {
  id: true,
  tenantId: true,
  externalRef: true,
  providerName: true,
  status: true,
  phoneMasked: true,
  disconnectedSince: true,
  providerEventAt: true,
  updatedAt: true,
} as const;

export type StatusSubject = Prisma.InstanceGetPayload<{ select: typeof SUBJECT_SELECT }>;

export interface TransitionInput {
  next: InstanceStatus;
  now?: Date;
  /** The full phone of a `connected` event. Only the masked value is stored. */
  phone?: string | undefined;
  /** The time of the provider observation. An observation older than the stored one is stale. */
  providerEventAt?: Date;
  /** More columns for the same update (for example `deletedAt`). The row is written also without a status change. */
  data?: Prisma.InstanceUpdateManyMutationInput;
  /** More writes in the same transaction (audit rows, connect tokens). */
  inTransaction?: (tx: TransactionClient, instance: StatusSubject) => Promise<void>;
}

export type TransitionResult =
  | { kind: 'missing' }
  | { kind: 'stale'; instance: StatusSubject }
  | { kind: 'applied'; changed: boolean; previous: InstanceStatus; instance: StatusSubject };

/**
 * The only writer of the instance status. One transaction locks the row (`FOR UPDATE`, so concurrent
 * events of one instance apply in sequence), applies the lifecycle rules of `planTransition`, and writes
 * the `instance.status` outbox event with `previous_status`. A duplicate status writes no event. After
 * the commit, the new status goes to the open connect streams.
 */
@Injectable()
export class InstanceStatusService {
  private readonly logger = getLogger('instance-status');

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly channel: ConnectChannelService,
    private readonly alerts: AlertService,
  ) {}

  async transition(lookup: InstanceLookup, input: TransitionInput): Promise<TransitionResult> {
    const now = input.now ?? new Date();
    const result = await this.prisma.$transaction((tx) => this.applyInTx(tx, lookup, input, now));
    if (result.kind === 'applied' && result.changed) {
      this.logger.info(
        {
          tenant_id: result.instance.tenantId,
          instance_id: result.instance.id,
          previous_status: result.previous,
          status: result.instance.status,
        },
        'instance status changed',
      );
      await this.notifyStreams(result.instance);
    }
    return result;
  }

  private async applyInTx(
    tx: TransactionClient,
    lookup: InstanceLookup,
    input: TransitionInput,
    now: Date,
  ): Promise<TransitionResult> {
    const row = await this.lockRow(tx, lookup);
    if (!row) {
      return { kind: 'missing' };
    }
    if (
      input.providerEventAt &&
      row.providerEventAt &&
      input.providerEventAt < row.providerEventAt
    ) {
      return { kind: 'stale', instance: row };
    }
    const plan = planTransition(row, input.next, now);
    const after: StatusSubject = {
      ...row,
      status: plan.status,
      phoneMasked: this.phoneOf(input, row),
      disconnectedSince: plan.disconnectedSince,
      providerEventAt: input.providerEventAt ?? row.providerEventAt,
    };
    await this.writeRow(tx, row, after, { changed: plan.changed, now, data: input.data });
    if (plan.changed) {
      await this.enqueueEvent(tx, row, after);
    }
    await input.inTransaction?.(tx, after);
    return { kind: 'applied', changed: plan.changed, previous: row.status, instance: after };
  }

  /** The `instance.status` event of the change, in the transaction of the change. */
  private async enqueueEvent(
    tx: TransactionClient,
    before: StatusSubject,
    after: StatusSubject,
  ): Promise<void> {
    await this.outbox.enqueue(tx, {
      tenantId: before.tenantId,
      type: 'instance.status',
      payload: {
        instance_id: before.id,
        external_ref: before.externalRef,
        status: after.status,
        previous_status: before.status,
        phone_masked: after.phoneMasked,
      },
    });
  }

  /**
   * Writes the row when something changed. A visible change (status, phone, extra columns) moves
   * `updatedAt`. A new provider time only is internal, so `updatedAt` stays.
   */
  private async writeRow(
    tx: TransactionClient,
    row: StatusSubject,
    after: StatusSubject,
    change: { changed: boolean; now: Date; data: TransitionInput['data'] },
  ): Promise<void> {
    const visible =
      change.changed || after.phoneMasked !== row.phoneMasked || change.data !== undefined;
    if (!visible && after.providerEventAt === row.providerEventAt) {
      return;
    }
    await tx.instance.update({
      where: { id: row.id },
      data: {
        ...change.data,
        status: after.status,
        phoneMasked: after.phoneMasked,
        disconnectedSince: after.disconnectedSince,
        providerEventAt: after.providerEventAt,
        ...(change.changed ? { statusChangedAt: change.now } : {}),
        ...(visible ? {} : { updatedAt: row.updatedAt }),
      },
    });
  }

  /** Locks the active row of the instance for the transaction and reads it. */
  private async lockRow(
    tx: TransactionClient,
    lookup: InstanceLookup,
  ): Promise<StatusSubject | null> {
    const condition =
      'id' in lookup
        ? Prisma.sql`"id" = ${lookup.id}::uuid AND "tenantId" = ${lookup.tenantId}::uuid`
        : Prisma.sql`"providerName" = ${lookup.providerName}`;
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "instances" WHERE ${condition} AND "deletedAt" IS NULL FOR UPDATE`;
    const id = locked[0]?.id;
    return id ? tx.instance.findUnique({ where: { id }, select: SUBJECT_SELECT }) : null;
  }

  /** The masked phone of a `connected` event, when it matches the contract format. */
  private phoneOf(input: TransitionInput, row: StatusSubject): string | null {
    if (input.next !== 'connected' || !input.phone) {
      return row.phoneMasked;
    }
    const masked = maskPhone(input.phone);
    if (!MaskedPhoneNumber.safeParse(masked).success) {
      this.logger.warn(
        { instance_id: row.id },
        'the provider phone has an unexpected format; not stored',
      );
      return row.phoneMasked;
    }
    return masked;
  }

  /**
   * Sends the new status to the open streams and removes the cached codes after a final status.
   * The status is already committed, so a Redis error only reduces the function: the stream gets the
   * status at its next open or at its expiry.
   */
  private async notifyStreams(instance: StatusSubject): Promise<void> {
    try {
      if (isStreamFinalStatus(instance.status)) {
        await this.channel.clearCodes(instance.id);
      }
      await this.channel.publish(instance.id, {
        kind: 'event',
        event: { type: 'status', status: instance.status },
      });
    } catch (error) {
      this.logger.error(
        { err: error, instance_id: instance.id },
        'connect stream notification failed; the open streams do not get the status',
      );
      void this.alerts.notify({
        severity: 'warning',
        title: 'Connect stream notification failed (Redis)',
        details: { instance_id: instance.id },
        dedupeKey: 'instances:connect-notify',
      });
    }
  }
}
