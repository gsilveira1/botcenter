import { describe, expect, it } from 'vitest';
import { BotId, HttpsUrl, IsoDateTime, MaskedPhoneNumber, PhoneNumber, Uuid } from './common.js';
import { CursorQuery, PAGE_LIMIT_DEFAULT, pageOf } from './pagination.js';
import { Scope, SCOPES } from './scopes.js';
import { z } from 'zod';

describe('PhoneNumber', () => {
  it.each(['5511987654321', '1234567890', '123456789012345'])('accepts %s', (value) => {
    expect(PhoneNumber.safeParse(value).success).toBe(true);
  });

  it.each(['+5511987654321', '0511987654321', '123456789', '1234567890123456', '55 11 98765'])(
    'refuses %s',
    (value) => {
      expect(PhoneNumber.safeParse(value).success).toBe(false);
    },
  );
});

describe('MaskedPhoneNumber', () => {
  it('accepts a masked number', () => {
    expect(MaskedPhoneNumber.safeParse('5511*****4321').success).toBe(true);
  });

  it('refuses a full number', () => {
    expect(MaskedPhoneNumber.safeParse('5511987654321').success).toBe(false);
  });
});

describe('HttpsUrl', () => {
  it('accepts and normalizes an HTTPS URL', () => {
    expect(HttpsUrl.parse('HTTPS://Example.COM/hook')).toBe('https://example.com/hook');
  });

  it.each(['http://example.com', 'ftp://example.com', 'https://user:pw@example.com/', 'not a url'])(
    'refuses %s',
    (value) => {
      expect(HttpsUrl.safeParse(value).success).toBe(false);
    },
  );

  it('refuses a URL longer than 2048 characters', () => {
    expect(HttpsUrl.safeParse(`https://example.com/${'a'.repeat(2048)}`).success).toBe(false);
  });
});

describe('Uuid and IsoDateTime', () => {
  it('accepts a UUID v7', () => {
    expect(Uuid.safeParse('01928f3e-8a3b-7c4d-9e5f-0123456789ab').success).toBe(true);
  });

  it('refuses a malformed UUID', () => {
    expect(Uuid.safeParse('not-a-uuid').success).toBe(false);
  });

  it('accepts UTC and offset times and refuses a date only', () => {
    expect(IsoDateTime.safeParse('2026-10-19T12:00:00.000Z').success).toBe(true);
    expect(IsoDateTime.safeParse('2026-10-19T09:00:00-03:00').success).toBe(true);
    expect(IsoDateTime.safeParse('2026-10-19').success).toBe(false);
  });
});

describe('BotId', () => {
  it.each(['onboarding', 'a', 'bot-2', 'a'.repeat(63)])('accepts %s', (value) => {
    expect(BotId.safeParse(value).success).toBe(true);
  });

  it.each(['-bot', 'Bot', 'bot_1', '', 'a'.repeat(64)])('refuses "%s"', (value) => {
    expect(BotId.safeParse(value).success).toBe(false);
  });
});

describe('Scope', () => {
  it('has the four scopes of the architecture plan', () => {
    expect(SCOPES).toEqual(['messages:send', 'instances:manage', 'bots:write', 'events:read']);
  });

  it('refuses an unknown scope', () => {
    expect(Scope.safeParse('admin').success).toBe(false);
  });
});

describe('CursorQuery', () => {
  it('uses the default limit', () => {
    expect(CursorQuery.parse({})).toEqual({ limit: PAGE_LIMIT_DEFAULT });
  });

  it('coerces the limit from a query string', () => {
    expect(CursorQuery.parse({ cursor: 'abc', limit: '10' })).toEqual({ cursor: 'abc', limit: 10 });
  });

  it.each(['0', '101', '2.5', 'x'])('refuses limit=%s', (limit) => {
    expect(CursorQuery.safeParse({ limit }).success).toBe(false);
  });

  it('refuses an empty cursor', () => {
    expect(CursorQuery.safeParse({ cursor: '' }).success).toBe(false);
  });
});

describe('pageOf', () => {
  const Page = pageOf(z.object({ id: z.string() }));

  it('accepts a last page', () => {
    expect(Page.safeParse({ data: [{ id: 'a' }], next_cursor: null }).success).toBe(true);
  });

  it('requires next_cursor', () => {
    expect(Page.safeParse({ data: [] }).success).toBe(false);
  });
});
