import { BotDefinition } from '@botcenter/contracts';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../../test/support/env';
import { MetricsService } from '../../metrics/metrics.service';
import type { AlertService } from '../../services/alert.service';
import { BotDataError } from '../bot-definitions.service';
import type { BotDefinitionsService, LoadedBotVersion } from '../bot-definitions.service';
import type { ConversationCacheService } from '../conversation-cache.service';
import { ConversationMetrics } from '../conversation-metrics';
import type { ConversationRecord } from '../conversation-record';
import type { AfterCommitService } from './after-commit.service';
import { BotHttpService } from './bot-http';
import type { ConversationLoader } from './conversation-loader.service';
import {
  ConversationConflictError,
  ConversationStepService,
  STEP_ATTEMPTS,
} from './conversation-step.service';
import type { PendingMessage } from './conversation-step.service';
import type { ConversationWriter } from './conversation-writer.service';
import type { EngineDiagnosticsReporter } from './engine-diagnostics';
import type { InstanceContext } from './instance-context';
import { WriteConflictError } from './step-plan';
import type { StepPlan } from './step-plan';

const definition = BotDefinition.parse({
  initial_state: 'menu',
  variables: { escolha: '' },
  states: {
    menu: {
      on_enter: [
        {
          type: 'send_message',
          message: {
            type: 'buttons',
            text: 'Escolha',
            buttons: [
              { id: 'sim', title: 'Sim' },
              { id: 'nao', title: 'Não' },
            ],
          },
        },
      ],
      transitions: [
        {
          condition: { type: 'button', id: 'sim' },
          target: 'fim',
          actions: [{ type: 'set_variable', name: 'escolha', value: 'sim' }],
        },
      ],
      timeout: { after_seconds: 60, target: 'fim' },
    },
    fim: { final: true, transitions: [] },
  },
});

const instance: InstanceContext = {
  tenantId: '0199a000-0000-7000-8000-000000000001',
  instanceId: '0199a000-0000-7000-8000-000000000002',
  providerName: 'inst_x',
  externalRef: 'owner-1',
  botId: '0199a000-0000-7000-8000-000000000003',
};

const pinned: LoadedBotVersion = { botId: instance.botId!, botSlug: 'b', version: 1, definition };
const current: LoadedBotVersion = { ...pinned, version: 2 };

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: '0199a000-0000-7000-8000-000000000004',
    tenantId: instance.tenantId,
    instanceId: instance.instanceId,
    contact: '5511987654321',
    botId: pinned.botId,
    botVersion: 1,
    state: 'menu',
    variables: { escolha: '' },
    version: 4,
    handoff: false,
    lastMenu: {
      kind: 'buttons',
      options: [
        { id: 'sim', title: 'Sim' },
        { id: 'nao', title: 'Não' },
      ],
    },
    ...overrides,
  };
}

function message(text: string, createdAt = new Date()): PendingMessage {
  return { id: 'm1', contact: '5511987654321', content: { type: 'text', text }, createdAt };
}

function build(loaded: ConversationRecord | null) {
  const metrics = new ConversationMetrics(new MetricsService(testEnv()));
  const loader = { load: vi.fn(async () => loaded) };
  const definitions = {
    version: vi.fn(async () => pinned),
    current: vi.fn(async () => current),
  };
  const writer = {
    write: vi.fn(async (plan: StepPlan) => ({ record: record(), replies: [], plan })),
    consumeOnly: vi.fn(async () => undefined),
    isPending: vi.fn(async () => true),
  };
  const afterCommit = { run: vi.fn(async () => []) };
  const cache = { delete: vi.fn(async () => undefined) };
  const alerts = { notify: vi.fn(async () => undefined) };
  const http = new BotHttpService(
    { postJson: vi.fn() },
    alerts as unknown as AlertService,
    metrics,
  );
  const service = new ConversationStepService(
    loader as unknown as ConversationLoader,
    definitions as unknown as BotDefinitionsService,
    writer as unknown as ConversationWriter,
    afterCommit as unknown as AfterCommitService,
    cache as unknown as ConversationCacheService,
    http,
    { report: vi.fn(async () => undefined) } as unknown as EngineDiagnosticsReporter,
    metrics,
    alerts as unknown as AlertService,
  );
  const plan = () => writer.write.mock.calls[0]![0];
  return { service, loader, definitions, writer, afterCommit, cache, alerts, plan };
}

describe('ConversationStepService.applyMessage', () => {
  it('starts a new conversation with the CURRENT bot version', async () => {
    const { service, plan, definitions } = build(null);
    await service.applyMessage(instance, message('Oi'));
    expect(definitions.current).toHaveBeenCalled();
    expect(plan()).toMatchObject({
      expectedVersion: null,
      bot: { version: 2 },
      result: { trigger: 'start', toState: 'menu', version: 0 },
      messageId: 'm1',
      lastMenu: { kind: 'buttons' },
    });
  });

  it('continues a running conversation with its PINNED version and maps "1" to the first button', async () => {
    const { service, plan, definitions } = build(record());
    await service.applyMessage(instance, message('1'));
    expect(definitions.current).not.toHaveBeenCalled();
    expect(plan()).toMatchObject({
      expectedVersion: 4,
      bot: { version: 1 },
      result: { trigger: 'message', toState: 'fim', variables: { escolha: 'sim' }, version: 5 },
    });
  });

  it('starts again on the same row when the conversation ended', async () => {
    const { service, plan } = build(record({ state: 'fim', version: 7 }));
    await service.applyMessage(instance, message('Oi'));
    expect(plan()).toMatchObject({
      conversationId: record().id,
      expectedVersion: 7,
      bot: { version: 2 },
      result: { trigger: 'start', version: 8 },
    });
  });

  it.each([
    ['handoff', record({ handoff: true }), instance, new Date()],
    ['no_bot', record(), { ...instance, botId: null }, new Date()],
    ['stale', record(), instance, new Date(Date.now() - 2 * 60 * 60_000)],
  ])('skips the bot step (%s) and consumes the message', async (reason, loaded, target, at) => {
    const { service, writer } = build(loaded);
    await expect(service.applyMessage(target, message('Oi', at))).resolves.toEqual([]);
    expect(writer.write).not.toHaveBeenCalled();
    expect(writer.consumeOnly).toHaveBeenCalledWith(
      instance.tenantId,
      'm1',
      reason === 'handoff' ? record().id : null,
    );
  });

  it('skips a message with an alert when the bot data is broken', async () => {
    const { service, writer, definitions, alerts } = build(record());
    definitions.version.mockRejectedValueOnce(new BotDataError('missing version'));
    await service.applyMessage(instance, message('Oi'));
    expect(writer.consumeOnly).toHaveBeenCalled();
    expect(alerts.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bot data error in a conversation step' }),
    );
  });

  it('reloads from PostgreSQL and runs the engine again after a write conflict', async () => {
    const { service, writer, loader, cache, afterCommit } = build(record());
    writer.write.mockRejectedValueOnce(new WriteConflictError('version changed'));
    await service.applyMessage(instance, message('1'));
    expect(writer.write).toHaveBeenCalledTimes(2);
    expect(cache.delete).toHaveBeenCalledWith(instance.instanceId, '5511987654321');
    expect(loader.load.mock.calls[1]).toEqual([instance, '5511987654321', { fresh: true }]);
    expect(afterCommit.run).toHaveBeenCalledTimes(1);
  });

  it('stops a retry when another step consumed the message, and fails after the last attempt', async () => {
    const consumed = build(record());
    consumed.writer.write.mockRejectedValueOnce(new WriteConflictError('consumed'));
    consumed.writer.isPending.mockResolvedValueOnce(false);
    await expect(consumed.service.applyMessage(instance, message('1'))).resolves.toEqual([]);
    expect(consumed.writer.write).toHaveBeenCalledTimes(1);

    const busy = build(record());
    busy.writer.write.mockRejectedValue(new WriteConflictError('version changed'));
    await expect(busy.service.applyMessage(instance, message('1'))).rejects.toBeInstanceOf(
      ConversationConflictError,
    );
    expect(busy.writer.write).toHaveBeenCalledTimes(STEP_ATTEMPTS);
  });

  it('does not hide an unexpected error', async () => {
    const { service, writer } = build(record());
    writer.write.mockRejectedValueOnce(new Error('database down'));
    await expect(service.applyMessage(instance, message('1'))).rejects.toThrow('database down');
  });
});

describe('ConversationStepService.applyTimer', () => {
  const job = (state: string, version: number) => ({
    tenantId: instance.tenantId,
    conversationId: record().id,
    state,
    conversationVersion: version,
  });

  it('moves the conversation when the timer matches the state and the version', async () => {
    const { service, plan, loader } = build(record());
    await service.applyTimer(instance, '5511987654321', job('menu', 4));
    expect(loader.load).toHaveBeenCalledWith(instance, '5511987654321', { fresh: true });
    expect(plan()).toMatchObject({
      messageId: null,
      expectedVersion: 4,
      result: { trigger: 'timeout', fromState: 'menu', toState: 'fim' },
    });
  });

  it.each([
    ['an old version', record(), job('menu', 3)],
    ['another state', record(), job('fim', 4)],
    ['a handoff', record({ handoff: true }), job('menu', 4)],
    [
      'another conversation',
      record({ id: '0199a000-0000-7000-8000-000000000009' }),
      job('menu', 4),
    ],
    ['no conversation', null, job('menu', 4)],
  ])('is a no-op for %s', async (_case, loaded, timer) => {
    const { service, writer } = build(loaded);
    await expect(service.applyTimer(instance, '5511987654321', timer)).resolves.toEqual([]);
    expect(writer.write).not.toHaveBeenCalled();
  });
});
