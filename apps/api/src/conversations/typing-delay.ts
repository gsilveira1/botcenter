import type { MessageContent } from '@botcenter/contracts';

/** Limits of the typing delay of a bot reply (ban mitigation: a person needs time to type). */
export const TYPING_DELAY = {
  minMs: 800,
  maxMs: 4_000,
  msPerCharacter: 30,
} as const;

/** The text that a person reads in a message: the length of this text sets the typing delay. */
function visibleText(content: MessageContent): string {
  switch (content.type) {
    case 'text':
      return content.text;
    case 'media':
      return content.caption ?? '';
    case 'buttons':
      return [content.text, ...content.buttons.map((button) => button.title)].join(' ');
    case 'list':
      return content.text;
  }
}

/** The typing delay of a bot reply: 30 ms for each character, from 800 ms to 4 s. */
export function typingDelayMs(content: MessageContent): number {
  const estimate = visibleText(content).length * TYPING_DELAY.msPerCharacter;
  return Math.min(TYPING_DELAY.maxMs, Math.max(TYPING_DELAY.minMs, estimate));
}
