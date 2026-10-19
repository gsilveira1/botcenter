import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSseParser } from '../lib/sse.mjs';

describe('createSseParser', () => {
  it('returns one message for each block, with the event type and the data', () => {
    const parse = createSseParser();
    const messages = parse('event: qrcode\ndata: {"type":"qrcode"}\n\nevent: status\ndata: x\n\n');
    assert.deepEqual(messages, [
      { event: 'qrcode', data: '{"type":"qrcode"}' },
      { event: 'status', data: 'x' },
    ]);
  });

  it('keeps an incomplete block until the next chunk', () => {
    const parse = createSseParser();
    assert.deepEqual(parse('event: status\nda'), []);
    assert.deepEqual(parse('ta: connected\n\n'), [{ event: 'status', data: 'connected' }]);
  });

  it('ignores comment lines (heartbeats) and accepts CRLF line ends', () => {
    const parse = createSseParser();
    assert.deepEqual(parse(': heartbeat\r\n\r\nid: 7\r\ndata: a\r\ndata: b\r\n\r\n'), [
      { event: 'message', data: 'a\nb', id: '7' },
    ]);
  });
});
