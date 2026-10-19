import { z } from 'zod';

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 100;
/** Maximum length of an opaque cursor. */
export const CURSOR_MAX_LENGTH = 512;

/** Query of every list route: `?cursor=&limit=`. The cursor is opaque to the client. */
export const CursorQuery = z.object({
  cursor: z.string().min(1).max(CURSOR_MAX_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
});
export type CursorQuery = z.infer<typeof CursorQuery>;

/** Response of every list route. `next_cursor` is `null` on the last page. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    next_cursor: z.string().min(1).max(CURSOR_MAX_LENGTH).nullable(),
  });
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}
