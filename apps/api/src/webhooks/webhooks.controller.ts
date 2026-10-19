import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Auth } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { RequireScope } from '../auth/decorators';
import { SkipIdempotency } from '../idempotency/idempotency.interceptor';
import { ApiOperation, ApiResponse } from '../openapi/openapi.decorators';
import {
  CreateWebhookBody,
  ListWebhookDeliveriesQueryDto,
  ListWebhooksQuery,
  WebhookCreatedResponseDto,
  WebhookDeliveryPageDto,
  WebhookDeliveryResponseDto,
  WebhookPageDto,
  WebhookParams,
} from './webhooks.dto';
import { WebhookDeliveriesService } from './webhook-deliveries.service';
import { WebhookSubscriptionsService } from './webhook-subscriptions.service';

/**
 * `/v1/webhooks`: the outgoing events of a tenant. All routes need the `events:read` scope.
 * The create and the rotation skip `Idempotency-Key`: the idempotency store keeps the response body in
 * plain text for 24 h, and the signing secret must exist only in the response and in `SecretBox`.
 */
@Controller('v1/webhooks')
@RequireScope('events:read')
export class WebhooksController {
  constructor(
    private readonly subscriptions: WebhookSubscriptionsService,
    private readonly deliveries: WebhookDeliveriesService,
  ) {}

  @Post()
  @HttpCode(201)
  @SkipIdempotency()
  @ApiOperation({
    summary: 'Register a webhook',
    description:
      'Registers an HTTPS URL for the given event types. The response shows the signing secret one time. ' +
      'A URL that resolves to a private, loopback, link-local, or metadata address gets 422 WEBHOOK_URL_FORBIDDEN. ' +
      'This route ignores Idempotency-Key, because the response contains the secret.',
  })
  @ApiResponse(201, { description: 'Registered', schema: WebhookCreatedResponseDto })
  create(@Auth() auth: AuthContext, @Body() body: CreateWebhookBody) {
    return this.subscriptions.create(auth, body);
  }

  @Get()
  @ApiOperation({ summary: 'List the webhooks', description: 'The secret is never in this list.' })
  @ApiResponse(200, { description: 'One page of webhooks', schema: WebhookPageDto })
  list(@Auth() auth: AuthContext, @Query() query: ListWebhooksQuery) {
    return this.subscriptions.list(auth, query);
  }

  @Get('deliveries')
  @ApiOperation({ summary: 'List the webhook deliveries', description: 'Newest first.' })
  @ApiResponse(200, { description: 'One page of deliveries', schema: WebhookDeliveryPageDto })
  listDeliveries(@Auth() auth: AuthContext, @Query() query: ListWebhookDeliveriesQueryDto) {
    return this.deliveries.list(auth, query);
  }

  @Post('deliveries/:id/redeliver')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Send a dead or failed delivery again',
    description:
      'Starts a new attempt cycle with the same event id. Other states get 409 CONFLICT.',
  })
  @ApiResponse(202, { description: 'Queued again', schema: WebhookDeliveryResponseDto })
  redeliver(@Auth() auth: AuthContext, @Param() params: WebhookParams) {
    return this.deliveries.redeliver(auth, params.id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a webhook',
    description: 'The pending deliveries of the webhook stop.',
  })
  @ApiResponse(204, { description: 'Deleted' })
  async remove(@Auth() auth: AuthContext, @Param() params: WebhookParams): Promise<void> {
    await this.subscriptions.remove(auth, params.id);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @SkipIdempotency()
  @ApiOperation({
    summary: 'Rotate the signing secret',
    description:
      'Returns a new secret one time. For 24 h, each delivery has two v1= signatures (new and old). ' +
      'This route ignores Idempotency-Key, because the response contains the secret.',
  })
  @ApiResponse(200, { description: 'Rotated', schema: WebhookCreatedResponseDto })
  rotateSecret(@Auth() auth: AuthContext, @Param() params: WebhookParams) {
    return this.subscriptions.rotateSecret(auth, params.id);
  }
}
