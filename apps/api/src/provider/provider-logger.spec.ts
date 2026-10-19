import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { pinoProviderLogger } from './provider-logger';

function memoryLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: pino({ level: 'debug', messageKey: 'msg' }, stream), lines };
}

describe('pinoProviderLogger', () => {
  it('writes each level with the fields and the message of the provider package', () => {
    const { logger, lines } = memoryLogger();
    const adapter = pinoProviderLogger(logger);

    adapter.debug({ operation: 'ping' }, 'debug line');
    adapter.info({ instance_name: 'inst_1' }, 'info line');
    adapter.warn({ http_status: 503 }, 'warn line');
    adapter.error({ route: '/message/sendText' }, 'error line');

    expect(lines.map((line) => [line['level'], line['msg']])).toEqual([
      [20, 'debug line'],
      [30, 'info line'],
      [40, 'warn line'],
      [50, 'error line'],
    ]);
    expect(lines[1]).toMatchObject({ instance_name: 'inst_1' });
    expect(lines[2]).toMatchObject({ http_status: 503 });
  });

  it('obeys the level of the pino logger', () => {
    const { logger, lines } = memoryLogger();
    logger.level = 'warn';
    const adapter = pinoProviderLogger(logger);

    adapter.debug({}, 'dropped');
    adapter.info({}, 'dropped');
    adapter.warn({}, 'kept');

    expect(lines.map((line) => line['msg'])).toEqual(['kept']);
  });
});
