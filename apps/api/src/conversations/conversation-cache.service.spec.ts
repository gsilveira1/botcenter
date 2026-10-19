import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import { MetricsService } from '../metrics/metrics.service';
import { redisKeys } from '../redis/redis-keys';
import {
  CONVERSATION_CACHE_TTL_SECONDS,
  ConversationCacheService,
} from './conversation-cache.service';
import { contactKey } from './conversation-keys';
import { ConversationMetrics } from './conversation-metrics';
import type { ConversationRecord } from './conversation-record';

const record: ConversationRecord = {
  id: '0199a000-0000-7000-8000-000000000004',
  tenantId: '0199a000-0000-7000-8000-000000000001',
  instanceId: '0199a000-0000-7000-8000-000000000002',
  contact: '5511987654321',
  botId: '0199a000-0000-7000-8000-000000000003',
  botVersion: 1,
  state: 'inicio',
  variables: { nome: 'Ana' },
  version: 2,
  handoff: false,
  lastMenu: null,
};

function build(redis: Partial<Record<'get' | 'set' | 'del' | 'eval', ReturnType<typeof vi.fn>>>) {
  const metrics = new ConversationMetrics(new MetricsService(testEnv()));
  return { cache: new ConversationCacheService(redis as unknown as Redis, metrics), metrics };
}

async function count(metrics: ConversationMetrics, result: string): Promise<number> {
  return (await metrics.cache.get()).values.find((v) => v.labels['result'] === result)?.value ?? 0;
}

describe('ConversationCacheService', () => {
  const key = redisKeys.conversation(record.instanceId, contactKey(record.contact));

  it('writes the record with a TTL under a key without the phone, and reads it back', async () => {
    const store = new Map<string, string>();
    const evalFn = vi.fn(async (_script: string, _keys: number, k: string, v: string) => {
      store.set(k, v);
      return 1;
    });
    const get = vi.fn(async (k: string) => store.get(k) ?? null);
    const { cache, metrics } = build({ get, eval: evalFn });
    await cache.set(record);
    expect(evalFn).toHaveBeenCalledWith(
      expect.any(String),
      1,
      key,
      JSON.stringify(record),
      record.version,
      CONVERSATION_CACHE_TTL_SECONDS,
    );
    expect(key).not.toContain(record.contact);
    await expect(cache.get(record.instanceId, record.contact)).resolves.toEqual(record);
    expect(await count(metrics, 'hit')).toBe(1);
  });

  it('never replaces a newer cached version with an older one (ARCH-09)', async () => {
    const evalFn = vi.fn(async () => 0);
    const { cache, metrics } = build({ eval: evalFn });
    await cache.set({ ...record, version: 1 });
    expect(await count(metrics, 'stale_write')).toBe(1);
  });

  it('gives null for a broken entry and for a Redis failure (PostgreSQL is used then)', async () => {
    const broken = build({ get: vi.fn(async () => '{"id": 1') });
    await expect(broken.cache.get(record.instanceId, record.contact)).resolves.toBeNull();
    const wrongShape = build({ get: vi.fn(async () => '{"id": "x"}') });
    await expect(wrongShape.cache.get(record.instanceId, record.contact)).resolves.toBeNull();
    const down = build({ get: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))) });
    await expect(down.cache.get(record.instanceId, record.contact)).resolves.toBeNull();
    expect(await count(down.metrics, 'error')).toBe(1);
  });

  it('deletes the entry when a write fails, and never throws', async () => {
    const del = vi.fn(async () => Promise.reject(new Error('down')));
    const { cache, metrics } = build({
      eval: vi.fn(async () => Promise.reject(new Error('down'))),
      del,
    });
    await expect(cache.set(record)).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith(key);
    expect(await count(metrics, 'error')).toBe(2);
  });
});
