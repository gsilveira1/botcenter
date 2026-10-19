import { Module } from '@nestjs/common';
import { CoreModule } from '../../src/core/core.module';
import { WorkerCoreModule } from '../../src/core/worker-core.module';
import { InboundWorkerModule } from '../../src/inbound/inbound.module';

/**
 * The worker core without the modules of the feature slices. Use it as the `root` of `h.startWorker()`
 * when a test needs a queue or an inbound kind that no feature consumer takes.
 */
@Module({ imports: [CoreModule, WorkerCoreModule, InboundWorkerModule] })
export class CoreWorkerRoot {}
