import { Module } from '@nestjs/common';
import { ConnectChannelService } from './connect-channel.service';
import { ConnectCorsHook } from './connect-cors';
import { ConnectEventsBus } from './connect-events.bus';
import { ConnectEventsController } from './connect-events.controller';
import { ConnectStreamService } from './connect-stream.service';
import { ConnectTokenService } from './connect-token.service';
import { ConnectionMonitorService } from './connection-monitor.service';
import { ConnectionUpdatedHandler, QrcodeUpdatedHandler } from './connection-handlers';
import { InstanceConnectService } from './instance-connect.service';
import { InstanceStatusService } from './instance-status.service';
import { InstancesJobsWorker } from './instances-jobs.worker';
import { InstancesController } from './instances.controller';
import { InstancesService } from './instances.service';
import { ProviderInstancesService } from './provider-instances.service';

/**
 * API process: the instance routes, the connect token verifier of `@ConnectToken()`, and the connect
 * event stream (Redis subscriber, CORS of the stream route).
 */
@Module({
  controllers: [InstancesController, ConnectEventsController],
  providers: [
    InstancesService,
    InstanceConnectService,
    ProviderInstancesService,
    InstanceStatusService,
    ConnectChannelService,
    ConnectTokenService,
    ConnectEventsBus,
    ConnectStreamService,
    ConnectCorsHook,
  ],
})
export class InstancesApiModule {}

/**
 * Worker process: the `qrcode.updated` and `connection.updated` handlers, and the `instances` queue
 * (connection monitor and reconciliation).
 */
@Module({
  providers: [
    InstanceStatusService,
    ConnectChannelService,
    QrcodeUpdatedHandler,
    ConnectionUpdatedHandler,
    ConnectionMonitorService,
    InstancesJobsWorker,
  ],
})
export class InstancesWorkerModule {}
