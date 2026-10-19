import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client';
import { sendCountsQuery, webhookCountsQuery } from '../../src/maintenance/operational-alerts.task';
import { TestHarness } from '../support/harness';

/**
 * ARCH-14: `check-alerts` runs every minute. Its two table queries must use an index, not a full scan of
 * `messages` (90 days) or `webhook_deliveries` (30 days). The test turns off sequential scans for the
 * transaction: when no index fits, PostgreSQL still uses a `Seq Scan`, so the plan shows the gap.
 */

let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start();
});

afterAll(async () => {
  await h?.close();
});

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

async function planOf(query: Prisma.Sql): Promise<PlanNode[]> {
  const rows = await h.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
    return tx.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
      Prisma.sql`EXPLAIN (FORMAT JSON) ${query}`,
    );
  });
  return nodes(rows[0]!['QUERY PLAN'][0]!.Plan);
}

describe('check-alerts query plans (ARCH-14)', () => {
  it('reads the outbound messages of the window through an index', async () => {
    const plan = await planOf(sendCountsQuery(new Date(Date.now() - 600_000)));
    const scans = plan.filter((node) => node['Relation Name'] === 'messages');
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.map((node) => node['Node Type'])).not.toContain('Seq Scan');
    expect(plan.map((node) => node['Index Name'])).toContain('messages_direction_createdAt_idx');
  });

  it('reads the webhook deliveries of the window through an index', async () => {
    const plan = await planOf(webhookCountsQuery(new Date(Date.now() - 900_000)));
    const scans = plan.filter((node) => node['Relation Name'] === 'webhook_deliveries');
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.map((node) => node['Node Type'])).not.toContain('Seq Scan');
    expect(plan.map((node) => node['Index Name'])).toContain('webhook_deliveries_updatedAt_idx');
  });
});
