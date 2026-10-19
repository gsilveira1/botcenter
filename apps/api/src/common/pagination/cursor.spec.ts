import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { decodeCursor, encodeCursor, keysetArgs, toPage } from './cursor';

const id = '0192a0b0-0000-7000-8000-000000000001';
const createdAt = new Date('2026-10-19T10:00:00.123Z');

describe('cursor pagination', () => {
  it('encodes an opaque base64url cursor and decodes it', () => {
    const cursor = encodeCursor({ createdAt, id });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual({ createdAt, id });
  });

  it('refuses a cursor that the codec did not make (400, path cursor)', () => {
    const bad = [
      'not-base64-json',
      Buffer.from('[]').toString('base64url'),
      Buffer.from(JSON.stringify({ c: 'x', i: id })).toString('base64url'),
      Buffer.from(JSON.stringify({ c: createdAt.toISOString(), i: "1' OR 1=1" })).toString(
        'base64url',
      ),
    ];
    for (const raw of bad) {
      expect(() => decodeCursor(raw)).toThrow(AppError);
      try {
        decodeCursor(raw);
      } catch (error) {
        expect((error as AppError).errors?.[0]?.path).toBe('cursor');
      }
    }
  });

  it('keysetArgs reads limit + 1 rows after the cursor in the order createdAt DESC, id DESC', () => {
    expect(keysetArgs({ limit: 10 })).toEqual({
      where: {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 11,
    });
    expect(keysetArgs({ limit: 2, cursor: encodeCursor({ createdAt, id }) }).where).toEqual({
      OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }],
    });
  });

  it('toPage cuts the extra row and gives next_cursor only when a next page exists', () => {
    const rows = [1, 2, 3].map((n) => ({
      id: `${id.slice(0, -1)}${n}`,
      createdAt: new Date(createdAt.getTime() - n),
    }));
    const page = toPage(rows, 2, (row) => row.id);
    expect(page.data).toHaveLength(2);
    expect(decodeCursor(page.next_cursor!)).toEqual({
      id: rows[1]!.id,
      createdAt: rows[1]!.createdAt,
    });
    expect(toPage(rows.slice(0, 2), 2, (row) => row.id).next_cursor).toBeNull();
  });
});
