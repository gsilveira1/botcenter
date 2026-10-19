import { describe, expect, it } from 'vitest';
import { CONVERSATION_ID, define, NOW } from './test-helpers.js';
import { pendingTimer, timerForState, timerJobId } from './timers.js';

const definition = define({
  initial_state: 'a',
  states: {
    a: { transitions: [], timeout: { after_seconds: 1800, target: 'b' } },
    b: { transitions: [] },
  },
});

describe('timerJobId', () => {
  it('is deterministic and has no colon (BullMQ custom id rule)', () => {
    expect(timerJobId(CONVERSATION_ID, 3)).toBe(`timer-${CONVERSATION_ID}-v3`);
    expect(timerJobId(CONVERSATION_ID, 3)).toBe(timerJobId(CONVERSATION_ID, 3));
    expect(timerJobId(CONVERSATION_ID, 3)).not.toContain(':');
  });

  it('changes with the version and with the conversation', () => {
    expect(timerJobId(CONVERSATION_ID, 3)).not.toBe(timerJobId(CONVERSATION_ID, 4));
    expect(timerJobId('other', 3)).not.toBe(timerJobId(CONVERSATION_ID, 3));
  });
});

describe('timerForState', () => {
  it('arms the timer of a state with a timeout', () => {
    expect(
      timerForState(definition, {
        conversationId: CONVERSATION_ID,
        state: 'a',
        version: 2,
        now: NOW,
      }),
    ).toEqual({
      state: 'a',
      version: 2,
      jobId: timerJobId(CONVERSATION_ID, 2),
      fireAt: new Date('2026-10-19T12:30:00.000Z'),
    });
  });

  it('gives null for a state without a timeout', () => {
    expect(
      timerForState(definition, {
        conversationId: CONVERSATION_ID,
        state: 'b',
        version: 2,
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe('pendingTimer', () => {
  it('names the timer that the write of the version armed', () => {
    expect(pendingTimer(definition, CONVERSATION_ID, 'a', 4)).toEqual({
      state: 'a',
      jobId: timerJobId(CONVERSATION_ID, 4),
    });
    expect(pendingTimer(definition, CONVERSATION_ID, 'b', 4)).toBeNull();
  });
});
