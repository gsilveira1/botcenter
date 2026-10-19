import type { BotDefinition } from '@botcenter/contracts';
import type { TimerPlan, TimerRef } from './types.js';

/**
 * The deterministic BullMQ job id of a state timer: `timer-<conversationId>-v<version>`.
 *
 * `version` is the conversation version that the API writes together with the timer. Every write
 * increments the version, so each entry into a state (also a second entry into the same state)
 * gives a new job id. The id has no `:` (BullMQ refuses `:` in a custom id) and it is not an integer.
 */
export function timerJobId(conversationId: string, version: number): string {
  return `timer-${conversationId}-v${version}`;
}

export interface TimerForStateInput {
  conversationId: string;
  state: string;
  /** The conversation version after the write that goes with this timer. */
  version: number;
  now: Date;
}

/**
 * The timer of a state, or `null` when the state has no timeout. Use it also when the API gives a
 * conversation back to the bot after a handoff: the handoff write makes the old timer stale.
 */
export function timerForState(
  definition: BotDefinition,
  input: TimerForStateInput,
): TimerPlan | null {
  const timeout = definition.states[input.state]?.timeout;
  if (timeout === undefined) {
    return null;
  }
  return {
    state: input.state,
    version: input.version,
    jobId: timerJobId(input.conversationId, input.version),
    fireAt: new Date(input.now.getTime() + timeout.after_seconds * 1000),
  };
}

/** The pending timer of the current state (armed by the write of `version`), or `null`. */
export function pendingTimer(
  definition: BotDefinition,
  conversationId: string,
  state: string,
  version: number,
): TimerRef | null {
  if (definition.states[state]?.timeout === undefined) {
    return null;
  }
  return { state, jobId: timerJobId(conversationId, version) };
}
