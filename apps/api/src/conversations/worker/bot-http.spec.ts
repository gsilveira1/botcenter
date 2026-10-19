import { ExternalCallError } from '@botcenter/engine';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../../test/support/env';
import { MetricsService } from '../../metrics/metrics.service';
import { ExternalHttpError } from '../../ports/external-http.port';
import type { AlertService } from '../../services/alert.service';
import { ConversationMetrics } from '../conversation-metrics';
import { BOT_WEBHOOK_TIMEOUT_MS, BotHttpService } from './bot-http';
import type { BotWebhookCall } from './bot-http';

const context = {
  conversation_id: 'c1',
  instance_id: 'i1',
  external_ref: 'o1',
  contact: '5511987654321',
  bot_id: 'bot',
  bot_version: 1,
};

function build() {
  const postJson = vi.fn();
  const alerts = { notify: vi.fn(async () => undefined) };
  const service = new BotHttpService(
    { postJson },
    alerts as unknown as AlertService,
    new ConversationMetrics(new MetricsService(testEnv())),
  );
  return { service, postJson, alerts };
}

const request = {
  conversationId: 'c1',
  state: 'confirmar',
  variables: { nome: 'Ana' },
  message: { type: 'button_reply' as const, buttonId: 'ok', text: 'OK' },
  timeoutMs: 2000,
  signal: new AbortController().signal,
};

describe('BotHttpService.externalCaller', () => {
  it('posts the conversation context and returns the JSON body', async () => {
    const { service, postJson } = build();
    postJson.mockResolvedValueOnce({ status: 200, json: { ok: true } });
    await expect(service.externalCaller(context).call('https://x.test', request)).resolves.toEqual({
      ok: true,
    });
    expect(postJson).toHaveBeenCalledWith({
      url: 'https://x.test',
      timeoutMs: 2000,
      body: {
        ...context,
        state: 'confirmar',
        variables: { nome: 'Ana' },
        message: { type: 'button_reply', button_id: 'ok', text: 'OK' },
      },
    });
  });

  it.each([
    [{ status: 503, json: {} }, 'http_status'],
    [{ status: 200, json: null }, 'invalid_json'],
  ])('throws ExternalCallError for %j', async (response, kind) => {
    const { service, postJson } = build();
    postJson.mockResolvedValueOnce(response);
    const error = await service
      .externalCaller(context)
      .call('https://x.test', request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCallError);
    expect((error as ExternalCallError).kind).toBe(kind);
  });

  it('maps the port errors (SSRF guard, time limit) to ExternalCallError kinds', async () => {
    const { service, postJson } = build();
    postJson.mockRejectedValueOnce(new ExternalHttpError('forbidden_address', 'private address'));
    const error = await service
      .externalCaller(context)
      .call('https://x.test', request)
      .catch((e: unknown) => e);
    expect((error as ExternalCallError).kind).toBe('blocked');
  });
});

describe('BotHttpService.callWebhooks', () => {
  const call: BotWebhookCall = {
    tenantId: 't1',
    url: 'https://hook.test',
    body: { ...context, state: 'fim', variables: {} },
  };

  it('posts each call with the time limit', async () => {
    const { service, postJson, alerts } = build();
    postJson.mockResolvedValue({ status: 204, json: null });
    await service.callWebhooks([call, call]);
    expect(postJson).toHaveBeenCalledTimes(2);
    expect(postJson).toHaveBeenCalledWith({
      url: call.url,
      body: call.body,
      timeoutMs: BOT_WEBHOOK_TIMEOUT_MS,
    });
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it('retries a time limit one time, then alerts; it does not retry a forbidden address', async () => {
    const timeout = build();
    timeout.postJson.mockRejectedValue(new ExternalHttpError('timeout', 'slow'));
    await timeout.service.callWebhooks([call]);
    expect(timeout.postJson).toHaveBeenCalledTimes(2);
    expect(timeout.alerts.notify).toHaveBeenCalledTimes(1);

    const forbidden = build();
    forbidden.postJson.mockRejectedValue(new ExternalHttpError('forbidden_address', 'private'));
    await forbidden.service.callWebhooks([call]);
    expect(forbidden.postJson).toHaveBeenCalledTimes(1);
  });

  it('alerts for an error status and throws an unexpected error', async () => {
    const status = build();
    status.postJson.mockResolvedValueOnce({ status: 500, json: null });
    await status.service.callWebhooks([call]);
    expect(status.alerts.notify).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'http_500' }) }),
    );

    const bug = build();
    bug.postJson.mockRejectedValueOnce(new TypeError('bug'));
    await expect(bug.service.callWebhooks([call])).rejects.toThrow('bug');
  });
});
