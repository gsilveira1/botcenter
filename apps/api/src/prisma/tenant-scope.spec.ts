import { describe, expect, it } from 'vitest';
import { TENANT_MODELS, scopeArgs } from './tenant-scope';

describe('tenant scope', () => {
  it('reads the tenant models from the generated client', () => {
    for (const model of [
      'ApiKey',
      'Instance',
      'Message',
      'OutboxEvent',
      'IdempotencyKey',
      'WebhookDelivery',
      'BotVersion',
    ]) {
      expect(TENANT_MODELS.has(model)).toBe(true);
    }
    for (const model of ['Tenant', 'RawEvent', 'AuditLog']) {
      expect(TENANT_MODELS.has(model)).toBe(false);
    }
  });

  it('adds the tenant filter to reads, updates, and deletes, and overrides a different tenant', () => {
    expect(scopeArgs('Message', 'findMany', { where: { status: 'queued' } }, 't')).toEqual({
      where: { status: 'queued', tenantId: 't' },
    });
    expect(
      scopeArgs('Message', 'findUnique', { where: { id: 'm', tenantId: 'other' } }, 't'),
    ).toEqual({ where: { id: 'm', tenantId: 't' } });
    expect(scopeArgs('Message', 'count', undefined, 't')).toEqual({ where: { tenantId: 't' } });
    expect(scopeArgs('Message', 'deleteMany', {}, 't')).toEqual({ where: { tenantId: 't' } });
  });

  it('adds the tenant id to creates and upserts', () => {
    expect(scopeArgs('Bot', 'create', { data: { slug: 'b', tenantId: 'other' } }, 't')).toEqual({
      data: { slug: 'b', tenantId: 't' },
    });
    expect(scopeArgs('Bot', 'createMany', { data: [{ slug: 'a' }] }, 't')).toEqual({
      data: [{ slug: 'a', tenantId: 't' }],
    });
    expect(
      scopeArgs('Bot', 'upsert', { where: { id: 'b' }, create: { slug: 'b' }, update: {} }, 't'),
    ).toEqual({
      where: { id: 'b', tenantId: 't' },
      create: { slug: 'b', tenantId: 't' },
      update: {},
    });
  });

  it('leaves models without a tenant as they are', () => {
    const args = { where: { id: 'x' } };
    expect(scopeArgs('RawEvent', 'findMany', args, 't')).toBe(args);
  });
});
