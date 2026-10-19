import type { InboundInput } from './types.js';

/**
 * The text of an inbound message that the `text` and `regex` conditions and
 * `set_variable from: "message_text"` use. The value is trimmed and in Unicode NFC.
 * - `text`: the text.
 * - `button_reply` and `list_reply`: the title that the user clicked.
 * - `media`: the caption, or `null` when there is no caption.
 * - `unsupported`: `null`.
 */
export function messageText(input: InboundInput): string | null {
  switch (input.type) {
    case 'text':
      return clean(input.text);
    case 'button_reply':
    case 'list_reply':
      return clean(input.text);
    case 'media':
      return input.caption === undefined ? null : clean(input.caption);
    case 'unsupported':
      return null;
  }
}

function clean(value: string): string {
  return value.normalize('NFC').trim();
}

const MARKS = /\p{M}+/gu;
const SPACES = /\s+/gu;

/**
 * The loose form of a text for a `text` condition with `case_sensitive: false`:
 * NFC, no accents (no combining marks), lowercase, and one space in place of each run of white space.
 * Example: `"  NÃO  sei "` and `"nao sei"` have the same loose form.
 */
export function looseText(value: string): string {
  return value
    .normalize('NFD')
    .replace(MARKS, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(SPACES, ' ')
    .trim();
}

/** The strict form for `case_sensitive: true`: NFC and trimmed. Case and accents stay. */
export function strictText(value: string): string {
  return clean(value);
}
