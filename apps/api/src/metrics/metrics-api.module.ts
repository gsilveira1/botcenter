import { Module } from '@nestjs/common';
import { InstanceIncidentsCollector } from './instance-incidents.collector';

/**
 * The metric collectors that read shared state (PostgreSQL). Only the API process imports this module
 * (`app.module.ts`), so a gauge is not counted two times. `MetricsModule` stays global in both processes.
 */
@Module({
  providers: [InstanceIncidentsCollector],
})
export class MetricsApiModule {}
