import { describe, expect, it } from 'vitest';
import { ChannelMessage, codeEvents, formatSseEvent } from './connect-events';
import { connectCorsHeaders } from './connect-cors';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('codeEvents', () => {
  it('removes the data URL prefix of the QR code image and keeps the raw QR text', () => {
    expect(
      codeEvents({ qrcodeBase64: `data:image/png;base64,${PNG}`, qrcode: '2@abc,def' }),
    ).toEqual([{ type: 'qrcode', png_base64: PNG, code: '2@abc,def' }]);
  });

  it('adds the 8-character pairing code', () => {
    expect(codeEvents({ qrcodeBase64: PNG, qrcode: '2@abc', pairingCode: 'WZYEH1YY' })).toEqual([
      { type: 'qrcode', png_base64: PNG, code: '2@abc' },
      { type: 'pairing_code', code: 'WZYEH1YY' },
    ]);
  });

  it('leaves out values that do not match the contract', () => {
    expect(codeEvents({ qrcodeBase64: 'not base64!', qrcode: 'x', pairingCode: 'abc' })).toEqual(
      [],
    );
    expect(codeEvents({ qrcode: '2@abc' })).toEqual([]);
    expect(codeEvents({})).toEqual([]);
  });
});

describe('formatSseEvent', () => {
  it('writes the type as the event field and the JSON as the data field', () => {
    expect(formatSseEvent({ type: 'status', status: 'connecting' })).toBe(
      'event: status\ndata: {"type":"status","status":"connecting"}\n\n',
    );
  });
});

describe('ChannelMessage', () => {
  it('accepts an event and a revoke message and refuses an invalid event', () => {
    expect(ChannelMessage.safeParse({ kind: 'event', event: { type: 'expired' } }).success).toBe(
      true,
    );
    expect(ChannelMessage.safeParse({ kind: 'revoke', keepTokenId: null }).success).toBe(true);
    expect(
      ChannelMessage.safeParse({ kind: 'event', event: { type: 'status', status: 'gone' } })
        .success,
    ).toBe(false);
  });
});

describe('connectCorsHeaders', () => {
  const allowed = ['https://app.example.com'];

  it('sends no CORS header when the list is empty', () => {
    expect(connectCorsHeaders('https://app.example.com', [])).toEqual({});
  });

  it('allows a listed origin and varies on the origin', () => {
    expect(connectCorsHeaders('https://app.example.com', allowed)).toEqual({
      'access-control-allow-origin': 'https://app.example.com',
      vary: 'Origin',
    });
  });

  it('does not allow an origin that is not in the list', () => {
    expect(connectCorsHeaders('https://evil.example.com', allowed)).toEqual({ vary: 'Origin' });
    expect(connectCorsHeaders(undefined, allowed)).toEqual({ vary: 'Origin' });
  });
});
