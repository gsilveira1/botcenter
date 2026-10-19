import { Inject, Injectable } from '@nestjs/common';
import { ProviderError } from '@botcenter/whatsapp-provider';
import type { ConnectInput, ConnectResult, WhatsAppProvider } from '@botcenter/whatsapp-provider';
import { AppError } from '../common/errors/app-error';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { INTERNAL_WEBHOOK_PATH } from '../inbound/internal-webhook.controller';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { WHATSAPP_PROVIDER } from '../provider/provider.tokens';

/** The fields of an instance that the provider calls need. */
export interface ProviderInstanceRef {
  id: string;
  tenantId: string;
  providerName: string;
  providerCreatedAt: Date | null;
}

/** Retry time of a 503 `PROVIDER_UNAVAILABLE` answer. */
const RETRY_AFTER_SECONDS = '30';

/**
 * Converts a provider error of a route to an API error. A transient error (`unavailable`,
 * `not_connected`) is 503 `PROVIDER_UNAVAILABLE` with `Retry-After`; the client can retry. A refusal of
 * the provider is 409 `CONFLICT`. The detail never contains the provider answer.
 */
export function providerFailure(error: ProviderError, operation: string): AppError {
  if (error.retryable) {
    return new AppError(
      'PROVIDER_UNAVAILABLE',
      `The WhatsApp provider is not available (${operation})`,
      {
        headers: { 'Retry-After': RETRY_AFTER_SECONDS },
        cause: error,
      },
    );
  }
  return new AppError('CONFLICT', `The WhatsApp provider refused the request (${operation})`, {
    cause: error,
  });
}

/**
 * The provider side of the instance lifecycle. The provider name is the opaque `inst_<uuid>`.
 * Recovery rule: a row with `providerCreatedAt = null` does not exist in the provider yet (the create call
 * failed, or the provider lost it). The next connect creates it again; the provider create is idempotent.
 */
@Injectable()
export class ProviderInstancesService {
  private readonly logger = getLogger('provider-instances');
  private readonly webhookUrl: string;

  constructor(
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    @Inject(ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
  ) {
    this.webhookUrl = `${env.INTERNAL_WEBHOOK_BASE_URL.replace(/\/+$/, '')}${INTERNAL_WEBHOOK_PATH}`;
  }

  /** Creates the instance in the provider (with the webhook and its secret) and records the time. */
  async create(instance: ProviderInstanceRef): Promise<void> {
    await this.provider.createInstance({
      name: instance.providerName,
      webhookUrl: this.webhookUrl,
      webhookSecret: this.env.EVOLUTION_WEBHOOK_SECRET,
    });
    // Raw SQL: an internal column, so `updatedAt` of the public answer does not change.
    await this.prisma.$executeRaw`
      UPDATE "instances" SET "providerCreatedAt" = now()
      WHERE "id" = ${instance.id}::uuid AND "tenantId" = ${instance.tenantId}::uuid`;
  }

  /**
   * Starts the connection. It creates the instance first when the row has no provider instance, and one
   * more time when the provider answers `not_found`.
   */
  async connect(instance: ProviderInstanceRef, input: ConnectInput): Promise<ConnectResult> {
    if (!instance.providerCreatedAt) {
      await this.create(instance);
    }
    try {
      return await this.provider.connect(instance.providerName, input);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.code !== 'not_found') {
        throw error;
      }
      this.logger.warn(
        { instance_id: instance.id },
        'the provider does not know the instance; it is created again',
      );
      await this.create(instance);
      return this.provider.connect(instance.providerName, input);
    }
  }

  /** Ends the session and deletes the instance in the provider. A missing instance is a success. */
  async remove(instance: ProviderInstanceRef): Promise<void> {
    try {
      await this.provider.logout(instance.providerName);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.code !== 'not_found') {
        throw error;
      }
    }
    await this.provider.deleteInstance(instance.providerName);
  }

  /** Runs a provider call of a route and converts a provider error to an API error (with a log line). */
  async forRoute<T>(operation: string, instanceId: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof ProviderError)) {
        throw error;
      }
      this.logger.warn(
        {
          err: error,
          instance_id: instanceId,
          operation,
          code: error.code,
          http_status: error.httpStatus,
        },
        'provider call failed',
      );
      throw providerFailure(error, operation);
    }
  }
}
