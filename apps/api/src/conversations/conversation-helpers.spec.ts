import { describe, expect, it } from 'vitest';
import { contactKey, conversationLockName } from './conversation-keys';
import { TYPING_DELAY, typingDelayMs } from './typing-delay';
import { uuidV7 } from './uuid-v7';

describe('uuidV7', () => {
  it('makes a version 7 UUID with the time in the first 48 bits', () => {
    const now = Date.UTC(2026, 9, 19, 12, 0, 0);
    const id = uuidV7(now);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(now);
    expect(uuidV7(now)).not.toBe(id);
  });
});

describe('conversation keys', () => {
  it('never puts the phone in a lock name', () => {
    const name = conversationLockName('inst-1', '5511987654321');
    expect(name).toBe(`conversation:inst-1:${contactKey('5511987654321')}`);
    expect(name).not.toContain('987654321');
    expect(contactKey('5511987654321')).not.toBe(contactKey('5511987654322'));
  });
});

describe('typingDelayMs', () => {
  it('uses the text length within the limits', () => {
    expect(typingDelayMs({ type: 'text', text: 'Oi' })).toBe(TYPING_DELAY.minMs);
    expect(typingDelayMs({ type: 'text', text: 'x'.repeat(50) })).toBe(1500);
    expect(typingDelayMs({ type: 'text', text: 'x'.repeat(4000) })).toBe(TYPING_DELAY.maxMs);
    expect(
      typingDelayMs({
        type: 'buttons',
        text: 'x'.repeat(40),
        buttons: [{ id: 'a', title: 'y'.repeat(9) }],
      }),
    ).toBe(50 * TYPING_DELAY.msPerCharacter);
    expect(typingDelayMs({ type: 'media', media_type: 'image', url: 'https://a.test/x.png' })).toBe(
      TYPING_DELAY.minMs,
    );
  });
});
