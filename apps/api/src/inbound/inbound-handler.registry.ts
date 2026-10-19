import { Injectable } from '@nestjs/common';
import type { ProviderEvent, ProviderEventKind } from '@botcenter/whatsapp-provider';

export type ProviderEventOf<K extends ProviderEventKind> = Extract<ProviderEvent, { kind: K }>;

export interface InboundJobContext {
  jobId: string;
  /** Attempts before this one (0 on the first attempt). */
  attemptsMade: number;
  rawEventId: string | null;
  receivedAt: Date;
}

/**
 * Processes one kind of normalized provider event in the worker process. Throw to retry the job (with
 * backoff). The handler must be idempotent: a retry can run it again for the same event.
 */
export interface InboundHandler<K extends ProviderEventKind = ProviderEventKind> {
  handle(event: ProviderEventOf<K>, context: InboundJobContext): Promise<void>;
}

/**
 * Wave 2 modules register one handler for each `ProviderEventKind` in `onModuleInit`:
 *
 *   @Injectable()
 *   export class MessageStatusHandler implements InboundHandler<'message.status'>, OnModuleInit {
 *     constructor(private readonly registry: InboundHandlerRegistry) {}
 *     onModuleInit() { this.registry.register('message.status', this); }
 *     async handle(event) { ... }
 *   }
 *
 * A second handler for the same kind is an error at start (one owner for each kind).
 */
@Injectable()
export class InboundHandlerRegistry {
  private readonly handlers = new Map<ProviderEventKind, InboundHandler>();

  register<K extends ProviderEventKind>(kind: K, handler: InboundHandler<K>): void {
    if (this.handlers.has(kind)) {
      throw new Error(`An inbound handler for "${kind}" is already registered`);
    }
    this.handlers.set(kind, handler as unknown as InboundHandler);
  }

  get<K extends ProviderEventKind>(kind: K): InboundHandler<K> | undefined {
    return this.handlers.get(kind) as InboundHandler<K> | undefined;
  }

  kinds(): ProviderEventKind[] {
    return [...this.handlers.keys()];
  }
}
