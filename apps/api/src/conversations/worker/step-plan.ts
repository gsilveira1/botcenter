import type { EngineResult } from '@botcenter/engine';
import type { LoadedBotVersion } from '../bot-definitions.service';
import type { ConversationRecord } from '../conversation-record';
import type { LastMenu } from '../menu-reply';
import type { InstanceContext } from './instance-context';

/** One engine step, ready to write. */
export interface StepPlan {
  instance: InstanceContext;
  contact: string;
  conversationId: string;
  /** The version that the write expects (optimistic lock), or `null` for a new conversation row. */
  expectedVersion: number | null;
  /** The bot version of the conversation after the step (the pinned version, or the current one at a start). */
  bot: LoadedBotVersion;
  result: EngineResult;
  /** The menu to keep for the next text reply (`conversations.lastMenu`). */
  lastMenu: LastMenu | null;
  /** The inbound row that the step consumes (`botPending` goes to false), or `null` for a timer. */
  messageId: string | null;
  now: Date;
}

/** An outbound reply row that the step wrote. The worker dispatches it after the commit. */
export interface WrittenReply {
  tenantId: string;
  messageId: string;
  instanceId: string;
}

export interface StepOutcome {
  record: ConversationRecord;
  replies: WrittenReply[];
}

/** The `version` of the row changed after the load: reload and run the step again. */
export class WriteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteConflictError';
  }
}

/** The record of the conversation after the write of `plan`. */
export function recordAfter(plan: StepPlan): ConversationRecord {
  const { result } = plan;
  return {
    id: plan.conversationId,
    tenantId: plan.instance.tenantId,
    instanceId: plan.instance.instanceId,
    contact: plan.contact,
    botId: plan.bot.botId,
    botVersion: plan.bot.version,
    state: result.toState,
    variables: result.variables,
    version: result.version,
    handoff: result.handoff,
    lastMenu: plan.lastMenu,
  };
}
