import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import type { TransactionClient } from '../prisma/prisma.service';
import { AlertService } from '../services/alert.service';
import { SecretBoxError } from '../services/secret-box';
import { buildSignedRequest } from './webhook-delivery.policy';
import { WebhookDeliveryJobs } from './webhook-delivery.jobs';
import type { DeliveryJobRef } from './webhook-delivery.jobs';
import { WebhookSecrets } from './webhook-secrets';

/** One `call_webhook` action of a bot step, before the insert. */
export interface NewBotWebhookCall {
  tenantId: string;
  botId: string;
  conversationId: string;
  url: string;
  /** The conversation context body (JSON). */
  payload: unknown;
}

/**
 * The `call_webhook` actions of the bots (ARCH-04, SEC-06) and the signature of the `external` condition.
 * The step transaction writes each action as a `bot_webhook_calls` row (`createInTx`); after the commit,
 * `dispatch` adds the jobs of the `webhooks` queue. The webhook delivery worker sends them with the lease,
 * the retry schedule, the dead state, the sweep, and the signature of the webhook deliveries, so a call is
 * delivered at least once.
 */
@Injectable()
export class BotWebhookCallsService {
  private readonly logger = getLogger('bot-webhook-calls');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: WebhookDeliveryJobs,
    private readonly secrets: WebhookSecrets,
    private readonly alerts: AlertService,
  ) {}

  /** Writes the calls in the transaction of the caller. Returns the references for `dispatch`. */
  async createInTx(
    tx: TransactionClient,
    calls: readonly NewBotWebhookCall[],
    now = new Date(),
  ): Promise<DeliveryJobRef[]> {
    if (calls.length === 0) {
      return [];
    }
    return tx.botWebhookCall.createManyAndReturn({
      data: calls.map((call) => ({
        tenantId: call.tenantId,
        botId: call.botId,
        conversationId: call.conversationId,
        url: call.url,
        payload: call.payload as Prisma.InputJsonValue,
        status: 'pending' as const,
        nextAttemptAt: now,
      })),
      select: { id: true, tenantId: true, nextAttemptAt: true },
    });
  }

  /** After the commit: adds the jobs. When Redis fails, the rows stay `pending` and the sweep adds them. */
  async dispatch(refs: readonly DeliveryJobRef[]): Promise<void> {
    if (refs.length > 0) {
      await this.jobs.enqueue(refs, Date.now(), 'bot_call');
    }
  }

  /**
   * The signature headers (`Webhook-Id`, `Webhook-Timestamp`, `Webhook-Signature`) of a synchronous bot
   * request (the `external` condition). The signature covers `JSON.stringify(body)`, the bytes that the
   * external HTTP client sends. Returns `null` when the bot has no usable secret (the caller refuses the
   * request: an unsigned request is not sent).
   */
  async signedHeaders(
    tenantId: string,
    botId: string,
    body: unknown,
    now = new Date(),
  ): Promise<Record<string, string> | null> {
    const bot = await this.prisma.forTenant(tenantId).bot.findUnique({
      where: { id: botId },
      select: {
        id: true,
        secretEncrypted: true,
        previousSecretEncrypted: true,
        previousSecretExpiresAt: true,
      },
    });
    if (!bot?.secretEncrypted) {
      this.logger.warn({ bot_id: botId }, 'bot has no signing secret; the request is not sent');
      return null;
    }
    let secrets: string[];
    try {
      secrets = this.secrets.signingSecrets({ ...bot, secretEncrypted: bot.secretEncrypted }, now);
    } catch (error) {
      if (!(error instanceof SecretBoxError)) {
        throw error;
      }
      this.logger.error(
        { err: error, bot_id: botId },
        'bot signing secret does not decrypt; check DATA_ENCRYPTION_KEY',
      );
      await this.alerts.notify({
        severity: 'critical',
        title: 'Webhook signing secret does not decrypt',
        details: { bot_id: botId },
        dedupeKey: 'webhooks:secret',
      });
      return null;
    }
    return buildSignedRequest(randomUUID(), body, secrets, Math.floor(now.getTime() / 1000))
      .headers;
  }
}
