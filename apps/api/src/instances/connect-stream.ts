import type { ConnectEvent } from '@botcenter/contracts';
import { SSE_HEARTBEAT, formatSseEvent } from './connect-events';
import type { ChannelMessage } from './connect-events';
import { isStreamFinalStatus } from './instance-status';

/** The output of a stream (the raw HTTP response in production, an array in tests). */
export interface StreamSink {
  write(chunk: string): void;
  end(): void;
}

/** The timer functions of a stream. Tests use the fake timers of Vitest. */
export interface StreamTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const SYSTEM_TIMERS: StreamTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export type CloseReason = 'final_status' | 'expired' | 'revoked' | 'client' | 'shutdown';

export interface ConnectStreamOptions {
  tokenId: string;
  heartbeatMs: number;
  timers?: StreamTimers;
  onClose?: (reason: CloseReason) => void;
}

/**
 * The logic of one connect SSE stream, without I/O:
 * - Messages that arrive before `start()` wait in a buffer, so no event is lost between the
 *   subscription and the first write.
 * - `start(expiresAt, initial)` writes the latest codes and the current status, then the buffered
 *   messages.
 * - A `status` event of `connected` or `logged_out` is written, then the stream closes.
 * - At `expiresAt`, the stream writes `expired` and closes. A heartbeat comment goes out every
 *   `heartbeatMs`.
 * - A `revoke` message for a different token (a newer connect call) writes `expired` and closes.
 * - The same event two times in a row is written one time.
 */
export class ConnectStream {
  private readonly timers: StreamTimers;
  private readonly buffer: ChannelMessage[] = [];
  private readonly lastByType = new Map<string, string>();
  private started = false;
  private closed = false;
  private heartbeat: unknown;
  private expiry: unknown;

  constructor(
    private readonly sink: StreamSink,
    private readonly options: ConnectStreamOptions,
  ) {
    this.timers = options.timers ?? SYSTEM_TIMERS;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  start(expiresAt: Date, initial: readonly ConnectEvent[]): void {
    if (this.started || this.closed) {
      return;
    }
    this.started = true;
    const remainingMs = expiresAt.getTime() - this.timers.now();
    if (remainingMs <= 0) {
      this.expire();
      return;
    }
    this.expiry = this.timers.setTimeout(() => this.expire(), remainingMs);
    this.heartbeat = this.timers.setInterval(
      () => this.writeRaw(SSE_HEARTBEAT),
      this.options.heartbeatMs,
    );
    for (const event of initial) {
      this.send(event);
    }
    for (const message of this.buffer.splice(0)) {
      this.handle(message);
    }
  }

  handle(message: ChannelMessage): void {
    if (this.closed) {
      return;
    }
    if (!this.started) {
      this.buffer.push(message);
      return;
    }
    if (message.kind === 'revoke') {
      if (message.keepTokenId !== this.options.tokenId) {
        this.send({ type: 'expired' });
        this.close('revoked');
      }
      return;
    }
    this.send(message.event);
  }

  close(reason: CloseReason): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.timers.clearTimeout(this.expiry);
    this.timers.clearInterval(this.heartbeat);
    this.sink.end();
    this.options.onClose?.(reason);
  }

  private expire(): void {
    this.send({ type: 'expired' });
    this.close('expired');
  }

  private send(event: ConnectEvent): void {
    if (this.closed) {
      return;
    }
    const frame = formatSseEvent(event);
    if (this.lastByType.get(event.type) === frame) {
      return;
    }
    this.lastByType.set(event.type, frame);
    this.writeRaw(frame);
    if (event.type === 'status' && isStreamFinalStatus(event.status)) {
      this.close('final_status');
    }
  }

  private writeRaw(chunk: string): void {
    if (!this.closed) {
      this.sink.write(chunk);
    }
  }
}
