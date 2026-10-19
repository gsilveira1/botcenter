import { Global, Module } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { EXTERNAL_HTTP } from '../../src/ports/external-http.port';
import type {
  ExternalHttpPort,
  ExternalHttpRequest,
  ExternalHttpResponse,
} from '../../src/ports/external-http.port';
import { OUTBOUND_MESSAGES } from '../../src/ports/outbound-messages.port';
import type {
  OutboundMessageInput,
  OutboundMessagesPort,
} from '../../src/ports/outbound-messages.port';
import type { TransactionClient } from '../../src/prisma/prisma.service';

/**
 * A fake of the messages slice port (for a worker without `MessagesCoreModule`): it writes a real `messages` row (outbound, `queued`) in the
 * transaction of the caller, so a rollback removes it, and records the inputs and the dispatches.
 */
export class FakeOutboundMessages implements OutboundMessagesPort {
  readonly created: (OutboundMessageInput & { messageId: string })[] = [];
  readonly dispatched: { tenantId: string; messageId: string; instanceId: string }[] = [];

  async createInTx(
    tx: TransactionClient,
    input: OutboundMessageInput,
  ): Promise<{ messageId: string }> {
    const row = await tx.message.create({
      data: {
        tenantId: input.tenantId,
        instanceId: input.instanceId,
        conversationId: input.conversationId ?? null,
        direction: 'outbound',
        type: input.content.type,
        status: 'queued',
        contact: input.to,
        content: input.content,
        priority: input.priority,
      },
      select: { id: true },
    });
    this.created.push({ ...input, messageId: row.id });
    return { messageId: row.id };
  }

  async dispatch(
    messages: ReadonlyArray<{ tenantId: string; messageId: string; instanceId: string }>,
  ): Promise<void> {
    this.dispatched.push(...messages);
  }

  reset(): void {
    this.created.length = 0;
    this.dispatched.length = 0;
  }
}

export type ExternalHttpHandler = (request: ExternalHttpRequest) => Promise<ExternalHttpResponse>;

/** A fake of the webhooks slice port: a programmable answer for each URL, and a record of the calls. */
export class FakeExternalHttp implements ExternalHttpPort {
  readonly calls: ExternalHttpRequest[] = [];
  private handler: ExternalHttpHandler = async () => ({ status: 200, json: {} });

  respondWith(handler: ExternalHttpHandler): void {
    this.handler = handler;
  }

  async postJson(request: ExternalHttpRequest): Promise<ExternalHttpResponse> {
    this.calls.push(request);
    return this.handler(request);
  }
}

/**
 * A global module that binds the fake `EXTERNAL_HTTP` port (the webhooks slice implements the real one).
 * `OUTBOUND_MESSAGES` comes from the global `MessagesCoreModule` of the worker; pass a fake only for a
 * worker without that module.
 */
export function conversationPortsModule(
  http: FakeExternalHttp,
  outbound?: FakeOutboundMessages,
): Type {
  const providers = [
    { provide: EXTERNAL_HTTP, useValue: http },
    ...(outbound ? [{ provide: OUTBOUND_MESSAGES, useValue: outbound }] : []),
  ];
  @Global()
  @Module({ providers, exports: providers.map((provider) => provider.provide) })
  class ConversationPortsTestModule {}
  return ConversationPortsTestModule;
}
