import { describe, expect, it, vi } from 'vitest';
import { testEnv } from '../../test/support/env';
import type { PrismaService } from '../prisma/prisma.service';
import { InstanceIncidentsCollector } from './instance-incidents.collector';
import { MetricsService } from './metrics.service';

interface CountArgs {
  where: { deletedAt: null; status: { in: string[] }; disconnectedSince: { lte: Date } };
}

describe('InstanceIncidentsCollector (ARCH-15)', () => {
  it('counts the incidents older than 2 minutes, recent (below 24 h) and stale, at each scrape', async () => {
    const now = new Date('2026-10-19T12:00:00Z');
    const count = vi.fn(async ({ where }: CountArgs) =>
      // 3 instances in an incident for more than 2 minutes, 1 of them for more than 24 hours.
      now.getTime() - where.disconnectedSince.lte.getTime() > 3_600_000 ? 1 : 3,
    );
    const metrics = new MetricsService(testEnv());
    const collector = new InstanceIncidentsCollector(metrics, {
      instance: { count },
    } as unknown as PrismaService);
    collector.onModuleInit();
    vi.useFakeTimers({ now, toFake: ['Date'] });
    try {
      const text = await metrics.render();
      expect(text).toContain('botcenter_instance_incidents{age="recent",role="api"} 2');
      expect(text).toContain('botcenter_instance_incidents{age="stale",role="api"} 1');
    } finally {
      vi.useRealTimers();
    }
    const [recent, stale] = count.mock.calls.map(([args]) => args.where);
    expect(recent).toMatchObject({
      deletedAt: null,
      status: { in: ['connecting', 'disconnected'] },
    });
    expect(now.getTime() - recent!.disconnectedSince.lte.getTime()).toBe(2 * 60_000);
    expect(now.getTime() - stale!.disconnectedSince.lte.getTime()).toBe(24 * 3_600_000);
  });
});
