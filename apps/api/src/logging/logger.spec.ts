import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { bindLogContext, currentLogContext, runWithLogContext } from './log-context';
import { createRootLogger, getLogger } from './logger';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  createRootLogger('info', stream);
  return lines;
}

describe('logger', () => {
  it('writes the request context fields on each line', () => {
    const lines = capture();
    runWithLogContext({ request_id: 'req-1' }, () => {
      bindLogContext({ tenant_id: 'tenant-1', instance_id: undefined });
      getLogger('test').info('inside');
    });
    getLogger('test').info('outside');
    expect(lines[0]).toMatchObject({
      msg: 'inside',
      level: 'info',
      request_id: 'req-1',
      tenant_id: 'tenant-1',
      module: 'test',
    });
    expect(lines[0]).not.toHaveProperty('instance_id');
    expect(lines[1]).not.toHaveProperty('request_id');
  });

  it('removes message content and secrets', () => {
    const lines = capture();
    getLogger().info(
      {
        text: 'hello',
        content: { text: 'x' },
        event: { caption: 'c', secret: 's' },
        headers: { authorization: 'Bearer x' },
      },
      'redacted',
    );
    const line = JSON.stringify(lines[0]);
    for (const value of ['hello', '"x"', '"c"', '"s"', 'Bearer']) {
      expect(line).not.toContain(value);
    }
  });

  it('keeps only the class and the code of a Prisma error', () => {
    const lines = capture();
    const error = Object.assign(new Error('Invalid value for phone 5511987654321'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
    });
    getLogger().error({ err: error }, 'failed');
    expect(lines[0]?.['err']).toEqual({ type: 'PrismaClientKnownRequestError', code: 'P2002' });
  });

  it('does nothing when bindLogContext runs outside a context', () => {
    bindLogContext({ tenant_id: 'x' });
    expect(currentLogContext()).toBeUndefined();
  });
});
