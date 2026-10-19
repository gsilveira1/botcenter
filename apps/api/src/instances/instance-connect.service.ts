import { Inject, Injectable } from '@nestjs/common';
import type {
  ConnectInstanceRequest,
  ConnectInstanceResponse,
  ConnectMethod,
} from '@botcenter/contracts';
import type { ConnectEvent } from '@botcenter/contracts';
import type { ConnectInput } from '@botcenter/whatsapp-provider';
import { assertInstanceAllowed } from '../auth/auth-context';
import type { AuthContext } from '../auth/auth-context';
import { notFound } from '../common/errors/app-error';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { getLogger } from '../logging/logger';
import type { TransactionClient } from '../prisma/prisma.service';
import { AlertService } from '../services/alert.service';
import { AuditService } from '../services/audit.service';
import { ConnectChannelService } from './connect-channel.service';
import { codeEvents } from './connect-events';
import { instanceAuditEntry } from './instance-audit';
import { ConnectTokenService } from './connect-token.service';
import type { IssuedConnectToken } from './connect-token.service';
import { InstanceStatusService } from './instance-status.service';
import { InstancesService } from './instances.service';
import { ProviderInstancesService } from './provider-instances.service';

export type ConnectOutcome =
  { kind: 'token'; response: ConnectInstanceResponse } | { kind: 'already_connected' };

/**
 * `POST /v1/instances/{id}/connect`: starts the connection in the provider, makes a connect token (one
 * active token for each instance), moves the instance to `connecting`, and shares the first codes with
 * the connect stream. The plan audits this action ("read the QR code").
 */
@Injectable()
export class InstanceConnectService {
  private readonly logger = getLogger('instance-connect');
  private readonly eventsBaseUrl: string;

  constructor(
    @Inject(ENV) env: AppEnv,
    private readonly instances: InstancesService,
    private readonly providerInstances: ProviderInstancesService,
    private readonly statuses: InstanceStatusService,
    private readonly tokens: ConnectTokenService,
    private readonly channel: ConnectChannelService,
    private readonly audit: AuditService,
    private readonly alerts: AlertService,
  ) {
    this.eventsBaseUrl = `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/v1/connect`;
  }

  async connect(
    auth: AuthContext,
    id: string,
    body: ConnectInstanceRequest,
  ): Promise<ConnectOutcome> {
    assertInstanceAllowed(auth, id);
    const row = await this.instances.findActive(auth.tenantId, id);
    const input: ConnectInput =
      body.method === 'qrcode'
        ? { method: 'qrcode' }
        : { method: 'pairing_code', phone: body.phone };
    const result = await this.providerInstances.forRoute('connect', id, () =>
      this.providerInstances.connect(row, input),
    );
    if (result.alreadyConnected) {
      await this.statuses.transition(
        { id, tenantId: auth.tenantId },
        {
          next: 'connected',
          inTransaction: (tx) =>
            this.auditConnect(tx, auth, id, { method: body.method, result: 'already_connected' }),
        },
      );
      return { kind: 'already_connected' };
    }
    const issued = await this.issueToken(auth, id, body.method);
    await this.shareCodes(id, issued.id, codeEvents(result));
    return {
      kind: 'token',
      response: {
        connect_token: issued.token,
        expires_at: issued.expiresAt.toISOString(),
        events_url: `${this.eventsBaseUrl}/${issued.token}/events`,
      },
    };
  }

  /** One transaction: the status `connecting` with its event, the new token, and the audit row. */
  private async issueToken(
    auth: AuthContext,
    id: string,
    method: ConnectMethod,
  ): Promise<IssuedConnectToken> {
    const now = new Date();
    let issued: IssuedConnectToken | undefined;
    const transition = await this.statuses.transition(
      { id, tenantId: auth.tenantId },
      {
        next: 'connecting',
        now,
        inTransaction: async (tx) => {
          issued = await this.tokens.issue(tx, {
            tenantId: auth.tenantId,
            instanceId: id,
            method,
            now,
          });
          await this.auditConnect(tx, auth, id, { method, result: 'token', token_id: issued.id });
        },
      },
    );
    if (transition.kind === 'missing' || !issued) {
      // The instance was deleted after the provider call.
      throw notFound('Instance');
    }
    return issued;
  }

  private async auditConnect(
    tx: TransactionClient,
    auth: AuthContext,
    instanceId: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    await this.audit.record(instanceAuditEntry(auth, instanceId, 'instance.connect', metadata), tx);
  }

  /**
   * Closes the streams of the older tokens and caches the codes of the connect answer. A Redis error
   * reduces the function only: the next `qrcode.updated` event of the provider brings a code.
   */
  private async shareCodes(
    instanceId: string,
    tokenId: string,
    events: ConnectEvent[],
  ): Promise<void> {
    try {
      await this.channel.publish(instanceId, { kind: 'revoke', keepTokenId: tokenId });
      if (events.length > 0) {
        await this.channel.publishCodes(instanceId, events);
      } else {
        await this.channel.clearCodes(instanceId);
      }
    } catch (error) {
      this.logger.error(
        { err: error, instance_id: instanceId },
        'connect codes not cached; the stream waits for the next code of the provider',
      );
      void this.alerts.notify({
        severity: 'warning',
        title: 'Connect codes not cached (Redis)',
        details: { instance_id: instanceId },
        dedupeKey: 'instances:connect-codes',
      });
    }
  }
}
