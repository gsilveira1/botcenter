import { Body, Controller, Delete, Get, Param, Post, Query, Res } from '@nestjs/common';
import {
  ConnectInstanceConnectedResponse,
  ConnectInstanceRequest,
  ConnectInstanceResponse,
  CreateInstanceRequest,
  InstancePage,
  InstanceResponse,
  ListInstancesQuery,
  UuidParam,
} from '@botcenter/contracts';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { Auth } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { RequireScope } from '../auth/decorators';
import { createZodDto } from '../common/zod-dto';
import type { ZodDto } from '../common/zod-dto';
import { SkipIdempotency } from '../idempotency/idempotency.interceptor';
import { ApiOperation, ApiResponse } from '../openapi/openapi.decorators';
import { InstanceConnectService } from './instance-connect.service';
import { InstancesService } from './instances.service';

class CreateInstanceBody extends createZodDto(CreateInstanceRequest) {}
// TypeScript cannot extend a union type: the class has the type `object`, the pipe gives the parsed union.
class ConnectInstanceBody extends (createZodDto(ConnectInstanceRequest) as ZodDto<
  z.ZodType<object>
>) {}
class ListInstancesQueryDto extends createZodDto(ListInstancesQuery) {}
class InstanceIdParams extends createZodDto(UuidParam) {}
class InstanceResponseDto extends createZodDto(InstanceResponse) {}
class InstancePageDto extends createZodDto(InstancePage) {}
class ConnectInstanceResponseDto extends createZodDto(ConnectInstanceResponse) {}
class ConnectInstanceConnectedResponseDto extends createZodDto(ConnectInstanceConnectedResponse) {}

@Controller('v1/instances')
export class InstancesController {
  constructor(
    private readonly instances: InstancesService,
    private readonly connector: InstanceConnectService,
  ) {}

  @Post()
  @RequireScope('instances:manage')
  @ApiOperation({
    summary: 'Create an instance for an external owner',
    description:
      'One active instance for each `external_ref`: when it exists, the answer is 200 with that instance. ' +
      'The API audits `consent_at`. A key with an instance list cannot create instances (403 ' +
      '`INSTANCE_NOT_ALLOWED`). The tenant quota `maxInstances` gives 429 `QUOTA_EXCEEDED`.',
  })
  @ApiResponse(201, { description: 'Created (status `created`)', schema: InstanceResponseDto })
  @ApiResponse(200, {
    description: 'The active instance of the owner',
    schema: InstanceResponseDto,
  })
  async create(
    @Auth() auth: AuthContext,
    @Body() body: CreateInstanceBody,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<InstanceResponse> {
    const outcome = await this.instances.create(auth, body);
    if (!outcome.created) {
      void reply.status(200);
    }
    return outcome.instance;
  }

  @Get()
  @RequireScope('instances:manage')
  @ApiOperation({
    summary: 'List the instances',
    description:
      'Newest first. Filter by `external_ref`. A key with an instance list sees only those instances.',
  })
  @ApiResponse(200, { description: 'One page of instances', schema: InstancePageDto })
  list(@Auth() auth: AuthContext, @Query() query: ListInstancesQueryDto): Promise<InstancePage> {
    return this.instances.list(auth, query);
  }

  @Get(':id')
  @RequireScope('instances:manage')
  @ApiOperation({ summary: 'Read an instance (connection status and limits)' })
  @ApiResponse(200, { description: 'The instance', schema: InstanceResponseDto })
  get(@Auth() auth: AuthContext, @Param() params: InstanceIdParams): Promise<InstanceResponse> {
    return this.instances.get(auth, params.id);
  }

  @Post(':id/connect')
  @RequireScope('instances:manage')
  // The answer has the connect token: it must not stay in the idempotency table. A repeated call makes a
  // new token and revokes the older one, so a retry has no other effect.
  @SkipIdempotency()
  @ApiOperation({
    summary: 'Start the connection (QR code or pairing code)',
    description:
      'Makes a one-use connect token (10 minutes) and revokes the older token of the instance. The browser ' +
      'opens `events_url` (Server-Sent Events). When the instance is already connected, the answer is 200 ' +
      'with `status` and no token. The route ignores `Idempotency-Key`. The provider is not available: 503 ' +
      '`PROVIDER_UNAVAILABLE` with `Retry-After`.',
  })
  @ApiResponse(201, { description: 'Connect token', schema: ConnectInstanceResponseDto })
  @ApiResponse(200, {
    description: 'Already connected',
    schema: ConnectInstanceConnectedResponseDto,
  })
  async connect(
    @Auth() auth: AuthContext,
    @Param() params: InstanceIdParams,
    @Body() body: ConnectInstanceBody,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ConnectInstanceResponse | ConnectInstanceConnectedResponse> {
    const outcome = await this.connector.connect(auth, params.id, body as ConnectInstanceRequest);
    if (outcome.kind === 'already_connected') {
      void reply.status(200);
      return { status: 'connected' };
    }
    return outcome.response;
  }

  @Delete(':id')
  @RequireScope('instances:manage')
  @ApiOperation({
    summary: 'Delete an instance',
    description:
      'Ends the WhatsApp session and deletes the instance in the provider, then deletes the instance ' +
      '(status `logged_out`) and revokes its connect tokens. The provider is not available: 503 ' +
      '`PROVIDER_UNAVAILABLE` and no change; retry the call.',
  })
  @ApiResponse(200, { description: 'The deleted instance', schema: InstanceResponseDto })
  remove(@Auth() auth: AuthContext, @Param() params: InstanceIdParams): Promise<InstanceResponse> {
    return this.instances.remove(auth, params.id);
  }
}
