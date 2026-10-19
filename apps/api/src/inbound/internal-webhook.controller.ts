import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Internal } from '../auth/decorators';
import { InboundIngestService } from './inbound-ingest.service';
import type { IngestResult } from './inbound-ingest.service';

/** Path of the provider webhook. `INTERNAL_WEBHOOK_BASE_URL` + this path is the URL that the provider calls. */
export const INTERNAL_WEBHOOK_PATH = '/internal/evolution/webhook';

/**
 * The webhook of the Evolution API on the internal network. Caddy does not forward `/internal/*`, and the
 * guard also needs a private client address and the shared secret header.
 */
@Controller('internal/evolution')
export class InternalWebhookController {
  constructor(private readonly ingest: InboundIngestService) {}

  @Post('webhook')
  @HttpCode(200)
  @Internal()
  receive(@Body() body: unknown): Promise<IngestResult> {
    return this.ingest.ingest(body);
  }
}
