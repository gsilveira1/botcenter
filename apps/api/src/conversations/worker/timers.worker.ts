import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { WorkerFactory } from '../../queues/worker.factory';
import { ConversationRuntime } from './conversation-runtime.service';

/** The consumer of the `timers` queue: one job is one state timeout of one conversation. */
@Injectable()
export class TimersWorker implements OnApplicationBootstrap {
  constructor(
    private readonly workers: WorkerFactory,
    private readonly runtime: ConversationRuntime,
  ) {}

  onApplicationBootstrap(): void {
    this.workers.create('timers', (job) => this.runtime.fireTimer(job.data));
  }
}
