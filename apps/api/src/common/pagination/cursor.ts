import type { CursorQuery, Page } from '@botcenter/contracts';
import { validationError } from '../errors/app-error';

/**
 * Keyset pagination over `(createdAt, id)`, newest first. The cursor is opaque to the client:
 * base64url of `{"c":"<ISO instant>","i":"<uuid>"}`. A cursor that this codec did not make gives
 * 400 `VALIDATION_FAILED` (path `cursor`), never a database error.
 *
 *   const rows = await prisma.message.findMany({ ...keysetArgs(query), where: { tenantId, ...keysetArgs(query).where } });
 *   return toPage(rows, query.limit, toMessageResponse);
 */
export interface CursorPosition {
  createdAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidCursor() {
  return validationError('The cursor is not valid', [
    { path: 'cursor', message: 'Malformed cursor' },
  ]);
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(
    JSON.stringify({ c: position.createdAt.toISOString(), i: position.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(raw: string): CursorPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw invalidCursor();
    }
    throw error;
  }
  if (!parsed || typeof parsed !== 'object') {
    throw invalidCursor();
  }
  const { c, i } = parsed as { c?: unknown; i?: unknown };
  if (typeof c !== 'string' || typeof i !== 'string' || !UUID.test(i)) {
    throw invalidCursor();
  }
  const createdAt = new Date(c);
  if (Number.isNaN(createdAt.getTime())) {
    throw invalidCursor();
  }
  return { createdAt, id: i };
}

/** The `where` filter of the rows after `position` in the order `createdAt DESC, id DESC`. */
export function afterCursorWhere(position: CursorPosition) {
  return {
    OR: [
      { createdAt: { lt: position.createdAt } },
      { createdAt: position.createdAt, id: { lt: position.id } },
    ],
  };
}

export const KEYSET_ORDER = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/**
 * The Prisma arguments of one page: `where` (empty without a cursor), `orderBy`, and `take` (limit + 1,
 * so that `toPage` knows if a next page exists). Merge `where` with the tenant filter of the caller.
 */
export function keysetArgs(query: Pick<CursorQuery, 'cursor' | 'limit'>) {
  return {
    where: query.cursor ? afterCursorWhere(decodeCursor(query.cursor)) : {},
    orderBy: KEYSET_ORDER,
    take: query.limit + 1,
  };
}

/** Cuts the rows (read with `take: limit + 1`) to one page and maps them to the response items. */
export function toPage<Row extends CursorPosition, Item>(
  rows: readonly Row[],
  limit: number,
  map: (row: Row) => Item,
): Page<Item> {
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    data: pageRows.map(map),
    next_cursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}
