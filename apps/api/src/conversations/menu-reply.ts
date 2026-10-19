import type { BotMessageContent } from '@botcenter/contracts';
import { looseText } from '@botcenter/engine';
import type { EngineAction, InboundInput } from '@botcenter/engine';
import { z } from 'zod';

/**
 * The text menu fallback of the provider: `buttons` and `list` messages go out as a numbered text menu,
 * so the user answers with plain text (`1`, `2`, or the title). The worker keeps the options of the last
 * bot menu in `conversations.lastMenu` and maps such a text reply to a `button_reply` or `list_reply`
 * input before the engine call. The numbers follow the provider: one sequence over all list sections.
 */
export const LastMenu = z.object({
  kind: z.enum(['buttons', 'list']),
  options: z.array(z.object({ id: z.string(), title: z.string() })).min(1),
});
export type LastMenu = z.infer<typeof LastMenu>;

/** A number with an optional `.` or `)` after it: `2`, `2.`, `2)`. */
const MENU_NUMBER = /^(\d{1,2})[.)]?$/;

/** Reads the stored column. A value that is not a menu (old or broken data) is `null`. */
export function parseLastMenu(value: unknown): LastMenu | null {
  const parsed = LastMenu.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function menuOf(message: BotMessageContent): LastMenu | null {
  if (message.type === 'buttons') {
    return {
      kind: 'buttons',
      options: message.buttons.map(({ id, title }) => ({ id, title })),
    };
  }
  if (message.type === 'list') {
    const rows = message.sections.flatMap((section) => section.rows);
    return { kind: 'list', options: rows.map(({ id, title }) => ({ id, title })) };
  }
  return null;
}

/**
 * The menu after a step: the menu of the last message that the step sends, or `null` when that message
 * is not a menu. A step without a message keeps the previous menu (the user can still answer it).
 */
export function menuAfterActions(
  actions: readonly EngineAction[],
  previous: LastMenu | null,
): LastMenu | null {
  const sends = actions.filter((action) => action.type === 'send_message');
  const last = sends.at(-1);
  return last === undefined ? previous : menuOf(last.message);
}

function findOption(text: string, menu: LastMenu): LastMenu['options'][number] | undefined {
  const value = text.normalize('NFC').trim();
  const number = MENU_NUMBER.exec(value);
  if (number?.[1] !== undefined) {
    return menu.options[Number(number[1]) - 1];
  }
  const loose = looseText(value);
  return menu.options.find((option) => looseText(option.title) === loose);
}

/**
 * Maps a text reply to the last menu: a number (`1` is the first option) or a title (case and accents
 * do not count). The result is a `button_reply` or `list_reply` with the option id and title. Any other
 * input stays as it is.
 */
export function mapMenuReply(input: InboundInput, menu: LastMenu | null): InboundInput {
  if (input.type !== 'text' || menu === null) {
    return input;
  }
  const option = findOption(input.text, menu);
  if (option === undefined) {
    return input;
  }
  return menu.kind === 'buttons'
    ? { type: 'button_reply', buttonId: option.id, text: option.title }
    : { type: 'list_reply', rowId: option.id, text: option.title };
}
