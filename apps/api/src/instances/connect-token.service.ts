import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { CONNECT_TOKEN_TTL_SECONDS } from '@botcenter/contracts';
import type { ConnectMethod } from '@botcenter/contracts';
import type { FastifyRequest } from 'fastify';
import type { ConnectTokenContext } from '../auth/auth-context';
import { ConnectTokenVerifierRegistry } from '../auth/connect-token.registry';
import type { ConnectTokenVerifier } from '../auth/connect-token.registry';
import { AppError } from '../common/errors/app-error';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import type { TransactionClient } from '../prisma/prisma.service';
import { generateConnectToken, hashConnectToken, isConnectTokenFormat } from './connect-token';

export interface IssuedConnectToken {
  id: string;
  token: string;
  expiresAt: Date;
}

export interface IssueInput {
  tenantId: string;
  instanceId: string;
  method: ConnectMethod;
  now: Date;
}

function invalidToken(): AppError {
  return new AppError('CONNECT_TOKEN_INVALID', 'The connect token is not valid');
}

/**
 * The connect tokens (10 minutes, one use, one active token for each instance). It is also the verifier
 * of `@ConnectToken()` routes: the first valid open marks the token used, so a second open gets 401
 * `CONNECT_TOKEN_INVALID`. Every refusal has the same answer; the log line has the reason.
 */
@Injectable()
export class ConnectTokenService implements ConnectTokenVerifier, OnModuleInit {
  private readonly logger = getLogger('connect-token');

  constructor(
    private readonly registry: ConnectTokenVerifierRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Revokes the tokens of the instance that are still valid and makes a new one. */
  async issue(tx: TransactionClient, input: IssueInput): Promise<IssuedConnectToken> {
    await this.revokeAll(tx, input.tenantId, input.instanceId, input.now);
    const generated = generateConnectToken();
    const expiresAt = new Date(input.now.getTime() + CONNECT_TOKEN_TTL_SECONDS * 1000);
    const row = await tx.connectToken.create({
      data: {
        tenantId: input.tenantId,
        instanceId: input.instanceId,
        tokenHash: generated.hash,
        method: input.method,
        expiresAt,
      },
      select: { id: true },
    });
    return { id: row.id, token: generated.token, expiresAt };
  }

  /** Ends the life of every valid token of the instance (a new connect call or a delete). */
  async revokeAll(
    tx: TransactionClient,
    tenantId: string,
    instanceId: string,
    now: Date,
  ): Promise<number> {
    const result = await tx.connectToken.updateMany({
      where: { tenantId, instanceId, expiresAt: { gt: now } },
      data: { expiresAt: now },
    });
    return result.count;
  }

  async verify(request: FastifyRequest): Promise<ConnectTokenContext> {
    const token = (request.params as Record<string, unknown> | undefined)?.['token'];
    if (!isConnectTokenFormat(token)) {
      return this.refuse('malformed');
    }
    const now = new Date();
    const row = await this.prisma.connectToken.findUnique({
      where: { tokenHash: hashConnectToken(token) },
      select: {
        id: true,
        tenantId: true,
        instanceId: true,
        expiresAt: true,
        usedAt: true,
        instance: { select: { deletedAt: true } },
      },
    });
    if (!row) {
      return this.refuse('unknown');
    }
    if (row.usedAt) {
      return this.refuse('used', row.id);
    }
    if (row.expiresAt <= now || row.instance.deletedAt) {
      return this.refuse('expired', row.id);
    }
    // The claim is atomic: two opens at the same time cannot both get the stream.
    const claimed = await this.prisma.connectToken.updateMany({
      where: { id: row.id, tenantId: row.tenantId, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) {
      return this.refuse('used', row.id);
    }
    return { tenantId: row.tenantId, instanceId: row.instanceId, tokenId: row.id };
  }

  private refuse(reason: string, tokenId?: string): never {
    this.logger.warn({ reason, token_id: tokenId }, 'connect token refused');
    throw invalidToken();
  }
}
