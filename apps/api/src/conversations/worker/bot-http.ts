import { Inject, Injectable } from '@nestjs/common';
import { ExternalCallError } from '@botcenter/engine';
import type {
  ExternalCallErrorKind,
  ExternalCaller,
  InboundInput,
  Variables,
} from '@botcenter/engine';
import { getLogger } from '../../logging/logger';
import { EXTERNAL_HTTP, ExternalHttpError } from '../../ports/external-http.port';
import type { ExternalHttpErrorCode, ExternalHttpPort } from '../../ports/external-http.port';
import { AlertService } from '../../services/alert.service';
import { ConversationMetrics } from '../conversation-metrics';
import type { ConversationRecord } from '../conversation-record';
import type { InstanceContext } from './instance-context';

/** Time limit of a `call_webhook` action (the action has no `timeout_ms`). */
export const BOT_WEBHOOK_TIMEOUT_MS = 5_000;
/** A `call_webhook` call that times out or has a network error gets one more attempt. */
const BOT_WEBHOOK_ATTEMPTS = 2;
const RETRYABLE: ReadonlySet<ExternalHttpErrorCode> = new Set(['timeout', 'network']);

const ERROR_KINDS: Record<ExternalHttpErrorCode, ExternalCallErrorKind> = {
  forbidden_address: 'blocked',
  timeout: 'timeout',
  network: 'network',
  response_too_large: 'invalid_json',
};

/** The conversation context that the client service receives (`external` condition and `call_webhook`). */
export interface ConversationContextBody {
  conversation_id: string;
  instance_id: string;
  external_ref: string;
  contact: string;
  bot_id: string;
  bot_version: number;
  state: string;
  variables: Variables;
}

/** One `call_webhook` action to run after the commit and after the lock of the conversation. */
export interface BotWebhookCall {
  tenantId: string;
  url: string;
  body: ConversationContextBody;
}

export function conversationContext(
  instance: InstanceContext,
  record: Pick<ConversationRecord, 'id' | 'contact' | 'state' | 'variables'>,
  bot: { botSlug: string; version: number },
): ConversationContextBody {
  return {
    conversation_id: record.id,
    instance_id: instance.instanceId,
    external_ref: instance.externalRef,
    contact: record.contact,
    bot_id: bot.botSlug,
    bot_version: bot.version,
    state: record.state,
    variables: record.variables,
  };
}

/** The message of an `external` call, in the snake case of the public API. */
function messageBody(input: InboundInput): Record<string, unknown> {
  switch (input.type) {
    case 'text':
      return { type: 'text', text: input.text };
    case 'button_reply':
      return { type: 'button_reply', button_id: input.buttonId, text: input.text };
    case 'list_reply':
      return { type: 'list_reply', list_row_id: input.rowId, text: input.text };
    case 'media':
      return { type: 'media', media_type: input.mediaType, text: input.caption };
    case 'unsupported':
      return { type: 'unsupported' };
  }
}

/**
 * The HTTP calls of the bots through the `EXTERNAL_HTTP` port (SSRF guard of the webhooks slice):
 * the engine `external` condition (inside the engine step, before the transaction) and the
 * `call_webhook` actions (after the commit, outside the conversation lock).
 */
@Injectable()
export class BotHttpService {
  private readonly logger = getLogger('bot-http');

  constructor(
    @Inject(EXTERNAL_HTTP) private readonly http: ExternalHttpPort,
    private readonly alerts: AlertService,
    private readonly metrics: ConversationMetrics,
  ) {}

  /** The engine port for one step. It throws `ExternalCallError` only, as the engine asks. */
  externalCaller(context: Omit<ConversationContextBody, 'state' | 'variables'>): ExternalCaller {
    return {
      call: async (url, request) => {
        const body = {
          ...context,
          state: request.state,
          variables: request.variables,
          message: messageBody(request.message),
        };
        const response = await this.post(url, body, request.timeoutMs);
        if (response.status < 200 || response.status >= 300) {
          throw new ExternalCallError('http_status', `HTTP ${response.status}`, response.status);
        }
        if (response.json === null) {
          throw new ExternalCallError('invalid_json', 'The response is not JSON');
        }
        return response.json;
      },
    };
  }

  /** Runs the `call_webhook` actions in order. A failure is logged, counted, and sent as an alert. */
  async callWebhooks(calls: readonly BotWebhookCall[]): Promise<void> {
    for (const call of calls) {
      const ok = await this.callWebhook(call);
      this.metrics.botWebhooks.inc({ result: ok ? 'succeeded' : 'failed' });
    }
  }

  private async callWebhook(call: BotWebhookCall): Promise<boolean> {
    for (let attempt = 1; attempt <= BOT_WEBHOOK_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.http.postJson({
          url: call.url,
          body: call.body,
          timeoutMs: BOT_WEBHOOK_TIMEOUT_MS,
        });
        if (response.status >= 200 && response.status < 300) {
          return true;
        }
        await this.failed(call, `http_${response.status}`);
        return false;
      } catch (error) {
        if (!(error instanceof ExternalHttpError)) {
          throw error;
        }
        if (!RETRYABLE.has(error.code) || attempt === BOT_WEBHOOK_ATTEMPTS) {
          await this.failed(call, error.code);
          return false;
        }
      }
    }
    return false;
  }

  private async post(url: string, body: unknown, timeoutMs: number) {
    try {
      return await this.http.postJson({ url, body, timeoutMs });
    } catch (error) {
      if (error instanceof ExternalHttpError) {
        throw new ExternalCallError(ERROR_KINDS[error.code], error.message, undefined, {
          cause: error,
        });
      }
      throw error;
    }
  }

  private async failed(call: BotWebhookCall, reason: string): Promise<void> {
    this.logger.warn(
      { conversation_id: call.body.conversation_id, reason },
      'call_webhook action failed',
    );
    await this.alerts.notify({
      severity: 'warning',
      title: 'Bot call_webhook action failed',
      details: { tenant_id: call.tenantId, bot_id: call.body.bot_id, reason },
      dedupeKey: `bot-webhook:${call.tenantId}:${call.body.bot_id}`,
    });
  }
}
