import { ExternalCallError } from '@botcenter/engine';
import { describe, expect, it, vi } from 'vitest';
import { ExternalHttpError } from '../../ports/external-http.port';
import type { BotWebhookCallsService } from '../../webhooks/bot-webhook-calls.service';
import { BotHttpService } from './bot-http';

const context = {
  conversation_id: 'c1',
  instance_id: 'i1',
  external_ref: 'o1',
  contact: '5511987654321',
  bot_id: 'bot',
  bot_version: 1,
};

const owner = { tenantId: 't1', botId: 'b1' };
const SIGNED = { 'Webhook-Id': 'w', 'Webhook-Timestamp': '1', 'Webhook-Signature': 'v1=x' };

function build(headers: Record<string, string> | null = SIGNED) {
  const postJson = vi.fn();
  const signer = { signedHeaders: vi.fn(async () => headers) };
  const service = new BotHttpService({ postJson }, signer as unknown as BotWebhookCallsService);
  return { service, postJson, signer };
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
  it('posts the conversation context signed with the bot secret and returns the JSON body', async () => {
    const { service, postJson, signer } = build();
    postJson.mockResolvedValueOnce({ status: 200, json: { ok: true } });
    await expect(
      service.externalCaller(context, owner).call('https://x.test', request),
    ).resolves.toEqual({ ok: true });
    const body = {
      ...context,
      state: 'confirmar',
      variables: { nome: 'Ana' },
      message: { type: 'button_reply', button_id: 'ok', text: 'OK' },
    };
    expect(signer.signedHeaders).toHaveBeenCalledWith('t1', 'b1', body);
    expect(postJson).toHaveBeenCalledWith({
      url: 'https://x.test',
      timeoutMs: 2000,
      body,
      headers: SIGNED,
    });
  });

  it('does not send an unsigned request when the bot has no usable secret (SEC-06)', async () => {
    const { service, postJson } = build(null);
    const error = await service
      .externalCaller(context, owner)
      .call('https://x.test', request)
      .catch((e: unknown) => e);
    expect((error as ExternalCallError).kind).toBe('blocked');
    expect(postJson).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 503, json: {} }, 'http_status'],
    [{ status: 200, json: null }, 'invalid_json'],
  ])('throws ExternalCallError for %j', async (response, kind) => {
    const { service, postJson } = build();
    postJson.mockResolvedValueOnce(response);
    const error = await service
      .externalCaller(context, owner)
      .call('https://x.test', request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCallError);
    expect((error as ExternalCallError).kind).toBe(kind);
  });

  it('maps the port errors (SSRF guard, time limit) to ExternalCallError kinds', async () => {
    const { service, postJson } = build();
    postJson.mockRejectedValueOnce(new ExternalHttpError('forbidden_address', 'private address'));
    const error = await service
      .externalCaller(context, owner)
      .call('https://x.test', request)
      .catch((e: unknown) => e);
    expect((error as ExternalCallError).kind).toBe('blocked');
  });
});
