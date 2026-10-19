import { describe, expect, it } from 'vitest';
import {
  ConnectEvent,
  ConnectInstanceRequest,
  ConnectInstanceResponse,
  CreateInstanceRequest,
  InstancePage,
  InstanceResponse,
  InstanceStatus,
  ListInstancesQuery,
} from './instances.js';

const ID = '01928f3e-8a3b-7c4d-9e5f-0123456789ab';
const NOW = '2026-10-19T12:00:00.000Z';

describe('CreateInstanceRequest', () => {
  it('accepts the minimal request', () => {
    expect(CreateInstanceRequest.parse({ external_ref: 'trainer-42', consent_at: NOW })).toEqual({
      external_ref: 'trainer-42',
      consent_at: NOW,
    });
  });

  it('accepts a rate limit', () => {
    expect(
      CreateInstanceRequest.safeParse({
        external_ref: 'trainer-42',
        consent_at: NOW,
        rate_limit_per_minute: 20,
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ consent_at: NOW }],
    [{ external_ref: 'trainer-42' }],
    [{ external_ref: 'has space', consent_at: NOW }],
    [{ external_ref: 'x'.repeat(129), consent_at: NOW }],
    [{ external_ref: 'trainer-42', consent_at: '19/10/2026' }],
    [{ external_ref: 'trainer-42', consent_at: NOW, rate_limit_per_minute: 0 }],
    [{ external_ref: 'trainer-42', consent_at: NOW, rate_limit_per_minute: 601 }],
  ])('refuses %j', (input) => {
    expect(CreateInstanceRequest.safeParse(input).success).toBe(false);
  });
});

describe('InstanceResponse', () => {
  const valid = {
    id: ID,
    external_ref: 'trainer-42',
    status: 'connected',
    phone_masked: '5511*****4321',
    bot_id: 'onboarding',
    rate_limit_per_minute: 20,
    created_at: NOW,
    updated_at: NOW,
  };

  it('accepts a connected instance', () => {
    expect(InstanceResponse.safeParse(valid).success).toBe(true);
  });

  it('accepts a new instance without a phone and a bot', () => {
    expect(
      InstanceResponse.safeParse({ ...valid, status: 'created', phone_masked: null, bot_id: null })
        .success,
    ).toBe(true);
  });

  it('refuses an unknown status', () => {
    expect(InstanceResponse.safeParse({ ...valid, status: 'online' }).success).toBe(false);
  });

  it('refuses a full phone number', () => {
    expect(InstanceResponse.safeParse({ ...valid, phone_masked: '5511987654321' }).success).toBe(
      false,
    );
  });

  it('is the item of InstancePage', () => {
    expect(InstancePage.safeParse({ data: [valid], next_cursor: 'c1' }).success).toBe(true);
  });
});

describe('InstanceStatus', () => {
  it('has the five lifecycle states', () => {
    expect(InstanceStatus.options).toEqual([
      'created',
      'connecting',
      'connected',
      'disconnected',
      'logged_out',
    ]);
  });
});

describe('ListInstancesQuery', () => {
  it('accepts the filter and the pagination', () => {
    expect(ListInstancesQuery.parse({ external_ref: 'trainer-42', limit: '5' })).toEqual({
      external_ref: 'trainer-42',
      limit: 5,
    });
  });
});

describe('ConnectInstanceRequest', () => {
  it('accepts the QR code method', () => {
    expect(ConnectInstanceRequest.safeParse({ method: 'qrcode' }).success).toBe(true);
  });

  it('accepts the pairing code method with a phone', () => {
    expect(
      ConnectInstanceRequest.safeParse({ method: 'pairing_code', phone: '5511987654321' }).success,
    ).toBe(true);
  });

  it('refuses the pairing code method without a phone', () => {
    const result = ConnectInstanceRequest.safeParse({ method: 'pairing_code' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['phone']);
  });

  it('refuses a phone with "+"', () => {
    expect(
      ConnectInstanceRequest.safeParse({ method: 'pairing_code', phone: '+5511987654321' }).success,
    ).toBe(false);
  });

  it('refuses an unknown method', () => {
    expect(ConnectInstanceRequest.safeParse({ method: 'sms' }).success).toBe(false);
  });
});

describe('ConnectInstanceResponse', () => {
  it('accepts a token and an events URL', () => {
    expect(
      ConnectInstanceResponse.safeParse({
        connect_token: 'a'.repeat(43),
        expires_at: NOW,
        events_url: `https://api.example.com/v1/connect/${'a'.repeat(43)}/events`,
      }).success,
    ).toBe(true);
  });

  it('refuses a short token', () => {
    expect(
      ConnectInstanceResponse.safeParse({
        connect_token: 'short',
        expires_at: NOW,
        events_url: 'https://api.example.com/x',
      }).success,
    ).toBe(false);
  });
});

describe('ConnectEvent', () => {
  it.each([
    [{ type: 'qrcode', png_base64: 'iVBORw0KGgo=', code: '2@abc,def' }],
    [{ type: 'pairing_code', code: 'ABCD1234' }],
    [{ type: 'status', status: 'connected' }],
    [{ type: 'expired' }],
  ])('accepts %j', (event) => {
    expect(ConnectEvent.safeParse(event).success).toBe(true);
  });

  it.each([
    [{ type: 'qrcode', png_base64: 'not base64!', code: 'x' }],
    [{ type: 'pairing_code', code: 'ABCD-1234' }],
    [{ type: 'pairing_code', code: 'abcd1234' }],
    [{ type: 'status', status: 'gone' }],
    [{ type: 'unknown' }],
  ])('refuses %j', (event) => {
    expect(ConnectEvent.safeParse(event).success).toBe(false);
  });
});
