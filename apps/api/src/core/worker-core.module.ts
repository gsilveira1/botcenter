import { Global, Module } from '@nestjs/common';
import { WorkerFactory } from '../queues/worker.factory';

/** The queue consumers of the worker process. `WorkerFactory` is global in the worker process only. */
@Global()
@Module({
  providers: [WorkerFactory],
  exports: [WorkerFactory],
})
export class WorkerCoreModule {}
