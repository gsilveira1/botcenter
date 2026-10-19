import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { ConnectEvent } from '@botcenter/contracts';
import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyReply } from 'fastify';
import type { ConnectTokenContext } from '../auth/auth-context';
import { notFound } from '../common/errors/app-error';
import { getLogger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../services/audit.service';
import { ConnectChannelService } from './connect-channel.service';
import { ConnectEventsBus } from './connect-events.bus';
import { ConnectStream } from './connect-stream';
import type { CloseReason } from './connect-stream';

/** A heartbeat comment every 15 s keeps the connection open through Caddy and Cloudflare. */
export const HEARTBEAT_MS = 15_000;

/**
 * The SSE headers. `no-transform` and `X-Accel-Buffering: no` stop the buffering and the compression of
 * the proxies, so each event reaches the browser at once.
 */
export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
  connection: 'keep-alive',
} as const;

/** The headers that the reply already has (request id, security headers, CORS) and the SSE headers. */
export function streamHeaders(current: Record<string, unknown>): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(current)) {
    if (typeof value === 'string' || typeof value === 'number' || Array.isArray(value)) {
      headers[name] = value as string | number | string[];
    }
  }
  return { ...headers, ...SSE_HEADERS };
}

interface StreamState {
  expiresAt: Date;
  initial: ConnectEvent[];
}

/**
 * Opens the connect event stream of a verified token (`GET /v1/connect/{token}/events`). The stream
 * gets the latest codes of the instance, its current status, and then the messages of the Redis channel
 * of the instance. A shutdown of the API closes the open streams, so the HTTP server can stop.
 */
@Injectable()
export class ConnectStreamService implements OnModuleDestroy {
  private readonly logger = getLogger('connect-stream');
  private readonly open = new Map<ConnectStream, () => Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: ConnectEventsBus,
    private readonly channel: ConnectChannelService,
    private readonly audit: AuditService,
  ) {}

  get openCount(): number {
    return this.open.size;
  }

  async stream(context: ConnectTokenContext, reply: FastifyReply): Promise<void> {
    const raw = reply.raw;
    const stream = new ConnectStream(
      { write: (chunk) => raw.write(chunk), end: () => raw.end() },
      {
        tokenId: context.tokenId,
        heartbeatMs: HEARTBEAT_MS,
        onClose: (reason) => this.closed(stream, reason),
      },
    );
    // Subscribe before the reads, so no message is lost between the reads and the first write.
    const unsubscribe = await this.bus.subscribe(context.instanceId, (message) =>
      stream.handle(message),
    );
    let state: StreamState;
    try {
      state = await this.readState(context);
      await this.auditOpen(context);
    } catch (error) {
      await unsubscribe();
      throw error;
    }
    void reply.hijack();
    if (!raw.socket || raw.socket.destroyed) {
      // The client left during the setup: no stream to write.
      await unsubscribe();
      return;
    }
    this.open.set(stream, unsubscribe);
    raw.writeHead(200, streamHeaders(reply.getHeaders()));
    raw.on('close', () => stream.close('client'));
    this.logger.info({ token_id: context.tokenId }, 'connect stream opened');
    stream.start(state.expiresAt, state.initial);
  }

  onModuleDestroy(): void {
    for (const stream of [...this.open.keys()]) {
      stream.close('shutdown');
    }
  }

  /** The expiry of the token, the latest codes, and the current status of the instance. */
  private async readState(context: ConnectTokenContext): Promise<StreamState> {
    const token = await this.prisma.forTenant(context.tenantId).connectToken.findFirst({
      where: { id: context.tokenId },
      select: { expiresAt: true, instance: { select: { status: true, deletedAt: true } } },
    });
    if (!token) {
      throw notFound('Connect token');
    }
    const status = token.instance.deletedAt ? 'logged_out' : token.instance.status;
    const codes = status === 'connected' ? [] : await this.channel.readCodes(context.instanceId);
    return { expiresAt: token.expiresAt, initial: [...codes, { type: 'status', status }] };
  }

  /** The plan audits the read of the QR code: the open of the stream is that read. */
  private async auditOpen(context: ConnectTokenContext): Promise<void> {
    await this.audit.record({
      tenantId: context.tenantId,
      actor: `connect_token:${context.tokenId}`,
      action: 'instance.connect_stream.open',
      targetType: 'instance',
      targetId: context.instanceId,
      metadata: { token_id: context.tokenId },
    });
  }

  private closed(stream: ConnectStream, reason: CloseReason): void {
    const unsubscribe = this.open.get(stream);
    this.open.delete(stream);
    this.logger.info({ reason }, 'connect stream closed');
    void unsubscribe?.();
  }
}
