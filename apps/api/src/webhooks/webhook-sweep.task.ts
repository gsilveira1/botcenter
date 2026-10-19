import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { MaintenanceTaskRegistry } from '../maintenance/maintenance-task.registry';
import type {
  MaintenanceTask,
  MaintenanceTaskResult,
} from '../maintenance/maintenance-task.registry';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookDeliveryJobs } from './webhook-delivery.jobs';

/** A delivery is overdue when its attempt time passed this long ago and no worker claimed it. */
export const SWEEP_OVERDUE_MS = 30_000;
/** Deliveries checked in one run. The next run continues. */
export const SWEEP_BATCH_SIZE = 200;

/**
 * `sweep-webhook-deliveries`, every minute: the fallback when a job is missing. A delivery or a bot call
 * (`bot_webhook_calls`) stays `pending` or `failed` with an old `nextAttemptAt` when Redis lost the job,
 * when the add failed after the commit, or when a worker stopped during an attempt (the lease ended). The
 * sweep adds the job again with the same deterministic id, so a job that still exists is not added two
 * times.
 */
@Injectable()
export class WebhookSweepTask implements MaintenanceTask, OnModuleInit {
  readonly name = 'sweep-webhook-deliveries' as const;
  readonly everyMs = 60_000;

  constructor(
    private readonly registry: MaintenanceTaskRegistry,
    private readonly prisma: PrismaService,
    private readonly jobs: WebhookDeliveryJobs,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(now: Date): Promise<MaintenanceTaskResult> {
    const due = { lt: new Date(now.getTime() - SWEEP_OVERDUE_MS) };
    const select = { id: true, tenantId: true, nextAttemptAt: true } as const;
    const overdue = await this.prisma.webhookDelivery.findMany({
      where: {
        status: { in: ['pending', 'failed'] },
        nextAttemptAt: due,
        subscription: { deletedAt: null },
      },
      select,
      orderBy: { nextAttemptAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
    });
    const overdueCalls = await this.prisma.botWebhookCall.findMany({
      where: { status: { in: ['pending', 'failed'] }, nextAttemptAt: due },
      select,
      orderBy: { nextAttemptAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
    });
    const requeued = await this.jobs.ensure(overdue);
    const requeuedCalls = await this.jobs.ensure(overdueCalls, 'bot_call');
    return {
      overdue: overdue.length,
      requeued,
      overdue_bot_calls: overdueCalls.length,
      requeued_bot_calls: requeuedCalls,
    };
  }
}
