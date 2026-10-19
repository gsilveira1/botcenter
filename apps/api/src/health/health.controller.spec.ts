import { ProviderError } from '@botcenter/whatsapp-provider';
import type { WhatsAppProvider } from '@botcenter/whatsapp-provider';
import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { HealthController, ReadinessSchema, runCheck } from './health.controller';

describe('runCheck', () => {
  it('reports up with the latency, down with the error code or class, and a timeout', async () => {
    expect(await runCheck(async () => 'ok')).toMatchObject({ status: 'up' });
    expect(
      await runCheck(async () =>
        Promise.reject(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })),
      ),
    ).toMatchObject({
      status: 'down',
      error: 'ECONNREFUSED',
    });
    expect(await runCheck(async () => Promise.reject(new TypeError('x')))).toMatchObject({
      error: 'TypeError',
    });
    expect(await runCheck(() => new Promise(() => undefined), 20)).toMatchObject({
      status: 'down',
      error: 'timeout',
    });
  });
});

describe('HealthController.ready', () => {
  it('answers 503 and a valid report when one check fails', async () => {
    const controller = new HealthController(
      { $queryRaw: vi.fn(async () => [1]) } as unknown as PrismaService,
      { ping: vi.fn(async () => 'PONG') } as unknown as Redis,
      {
        ping: vi.fn(async () => Promise.reject(new ProviderError('unavailable', 'down'))),
      } as unknown as WhatsAppProvider,
    );
    const reply = { status: vi.fn() };
    const report = await controller.ready(reply as unknown as FastifyReply);
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(ReadinessSchema.parse(report).checks.provider).toMatchObject({
      status: 'down',
      error: 'unavailable',
    });
    expect(controller.live()).toEqual({ status: 'ok' });
  });
});
