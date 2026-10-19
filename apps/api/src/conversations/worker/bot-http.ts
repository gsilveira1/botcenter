import { Inject, Injectable } from '@nestjs/common';
import { ExternalCallError } from '@botcenter/engine';
import type {
  ExternalCallErrorKind,
  ExternalCaller,
  InboundInput,
  Variables,
} from '@botcenter/engine';
import { EXTERNAL_HTTP, ExternalHttpError } from '../../ports/external-http.port';
import type { ExternalHttpErrorCode, ExternalHttpPort } from '../../ports/external-http.port';
import { BotWebhookCallsService } from '../../webhooks/bot-webhook-calls.service';
import type { NewBotWebhookCall } from '../../webhooks/bot-webhook-calls.service';
import type { ConversationRecord } from '../conversation-record';
import type { InstanceContext } from './instance-context';
import type { StepPlan } from './step-plan';

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

/**
 * The `call_webhook` actions of one step as rows of `bot_webhook_calls` (ARCH-04). Each body has the
 * variables at the position of its action. The writer inserts them in the step transaction.
 */
export function botWebhookCalls(plan: StepPlan, record: ConversationRecord): NewBotWebhookCall[] {
  return plan.result.actions.flatMap((action) =>
    action.type === 'call_webhook'
      ? [
          {
            tenantId: plan.instance.tenantId,
            botId: plan.bot.botId,
            conversationId: plan.conversationId,
            url: action.url,
            payload: conversationContext(
              plan.instance,
              { ...record, variables: action.variables },
              plan.bot,
            ),
          },
        ]
      : [],
  );
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
 * The synchronous HTTP call of the bots through the `EXTERNAL_HTTP` port (SSRF guard of the webhooks
 * slice): the engine `external` condition, inside the engine step, before the transaction. The request
 * is signed with the secret of the bot like a webhook (SEC-06). The `call_webhook` actions are rows of
 * `bot_webhook_calls` that the `webhooks` queue delivers (`botWebhookCalls`, ARCH-04).
 */
@Injectable()
export class BotHttpService {
  constructor(
    @Inject(EXTERNAL_HTTP) private readonly http: ExternalHttpPort,
    private readonly signer: BotWebhookCallsService,
  ) {}

  /** The engine port for one step. It throws `ExternalCallError` only, as the engine asks. */
  externalCaller(
    context: Omit<ConversationContextBody, 'state' | 'variables'>,
    owner: { tenantId: string; botId: string },
  ): ExternalCaller {
    return {
      call: async (url, request) => {
        const body = {
          ...context,
          state: request.state,
          variables: request.variables,
          message: messageBody(request.message),
        };
        const headers = await this.signer.signedHeaders(owner.tenantId, owner.botId, body);
        if (!headers) {
          throw new ExternalCallError('blocked', 'The bot has no usable signing secret');
        }
        const response = await this.post(url, body, request.timeoutMs, headers);
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

  private async post(
    url: string,
    body: unknown,
    timeoutMs: number,
    headers: Record<string, string>,
  ) {
    try {
      // The client sends `JSON.stringify(body)`: the same bytes that the signature covers.
      return await this.http.postJson({ url, body, timeoutMs, headers });
    } catch (error) {
      if (error instanceof ExternalHttpError) {
        throw new ExternalCallError(ERROR_KINDS[error.code], error.message, undefined, {
          cause: error,
        });
      }
      throw error;
    }
  }
}
