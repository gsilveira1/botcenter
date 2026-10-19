import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectStream } from './connect-stream';
import type { CloseReason } from './connect-stream';

const QR = { type: 'qrcode', png_base64: 'iVBORw0KGgo=', code: '2@abc' } as const;
const START = new Date('2026-10-19T12:00:00.000Z');

function setup(options: { tokenId?: string } = {}) {
  const chunks: string[] = [];
  const closes: CloseReason[] = [];
  let ended = 0;
  const stream = new ConnectStream(
    { write: (chunk) => chunks.push(chunk), end: () => (ended += 1) },
    {
      tokenId: options.tokenId ?? 'token-1',
      heartbeatMs: 15_000,
      onClose: (reason) => closes.push(reason),
    },
  );
  return {
    stream,
    chunks,
    closes,
    ended: () => ended,
    events: () =>
      chunks.filter((chunk) => chunk.startsWith('event:')).map((chunk) => chunk.split('\n')[0]),
  };
}

const inMinutes = (minutes: number) => new Date(START.getTime() + minutes * 60_000);

describe('ConnectStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the initial codes and status first, then the buffered messages', () => {
    const { stream, events } = setup();
    stream.handle({ kind: 'event', event: { type: 'pairing_code', code: 'ABCD1234' } });
    expect(events()).toEqual([]);

    stream.start(inMinutes(10), [QR, { type: 'status', status: 'connecting' }]);

    expect(events()).toEqual(['event: qrcode', 'event: status', 'event: pairing_code']);
  });

  it('sends a heartbeat comment every 15 s', () => {
    const { stream, chunks } = setup();
    stream.start(inMinutes(10), []);
    vi.advanceTimersByTime(45_000);
    expect(chunks.filter((chunk) => chunk === ': heartbeat\n\n')).toHaveLength(3);
  });

  it('writes the connected status and closes; later messages are dropped', () => {
    const { stream, events, closes, ended } = setup();
    stream.start(inMinutes(10), [QR]);
    stream.handle({ kind: 'event', event: { type: 'status', status: 'connected' } });
    stream.handle({ kind: 'event', event: QR });
    vi.advanceTimersByTime(60_000);

    expect(events()).toEqual(['event: qrcode', 'event: status']);
    expect(closes).toEqual(['final_status']);
    expect(ended()).toBe(1);
  });

  it('closes after a logged_out status in the initial events', () => {
    const { stream, closes } = setup();
    stream.start(inMinutes(10), [{ type: 'status', status: 'logged_out' }]);
    expect(closes).toEqual(['final_status']);
  });

  it('writes expired at the end of the token and closes', () => {
    const { stream, chunks, closes } = setup();
    stream.start(inMinutes(10), [QR]);
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(closes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(chunks.at(-1)).toBe('event: expired\ndata: {"type":"expired"}\n\n');
    expect(closes).toEqual(['expired']);
  });

  it('expires at once when the token is already at its end', () => {
    const { stream, events, closes } = setup();
    stream.start(START, [QR]);
    expect(events()).toEqual(['event: expired']);
    expect(closes).toEqual(['expired']);
  });

  it('closes on a revoke for a different token and ignores a revoke for its own token', () => {
    const own = setup({ tokenId: 'token-2' });
    own.stream.start(inMinutes(10), []);
    own.stream.handle({ kind: 'revoke', keepTokenId: 'token-2' });
    expect(own.closes).toEqual([]);

    const old = setup({ tokenId: 'token-1' });
    old.stream.start(inMinutes(10), []);
    old.stream.handle({ kind: 'revoke', keepTokenId: 'token-2' });
    expect(old.events()).toEqual(['event: expired']);
    expect(old.closes).toEqual(['revoked']);
  });

  it('writes the same event one time when it repeats', () => {
    const { stream, events } = setup();
    stream.start(inMinutes(10), [QR, { type: 'status', status: 'connecting' }]);
    stream.handle({ kind: 'event', event: QR });
    stream.handle({ kind: 'event', event: { type: 'status', status: 'connecting' } });
    stream.handle({ kind: 'event', event: { ...QR, code: '2@new' } });
    expect(events()).toEqual(['event: qrcode', 'event: status', 'event: qrcode']);
  });

  it('closes one time and stops the timers on a client close', () => {
    const { stream, chunks, closes, ended } = setup();
    stream.start(inMinutes(10), []);
    stream.close('client');
    stream.close('shutdown');
    vi.advanceTimersByTime(20 * 60_000);
    expect(closes).toEqual(['client']);
    expect(ended()).toBe(1);
    expect(chunks).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
