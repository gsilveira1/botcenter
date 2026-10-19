import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prodImage } from './helpers/images.js';
import { readRepoFile, readYaml } from './helpers/repo.js';

/**
 * SEC-11: Redis users of compose.prod.yml. The test runs the Redis command of the production file
 * (Compose `$$` is `$` in the shell) and checks each user with the clients of the stack.
 */
const PASSWORDS = {
  REDIS_PASSWORD: 'a'.repeat(64),
  REDIS_BOTCENTER_PASSWORD: 'b'.repeat(64),
  REDIS_EVOLUTION_PASSWORD: 'c'.repeat(64),
  REDIS_METRICS_PASSWORD: 'd'.repeat(64),
};

function redisCommand(): string[] {
  const compose = readYaml<{ services: Record<string, { command: string[] }> }>(
    'infra/compose/compose.prod.yml',
  );
  return compose.services.redis!.command.map((part) => part.replaceAll('$$', '$'));
}

let network: StartedNetwork;
let redis: StartedTestContainer;
const clients: Redis[] = [];

function connect(user: string, password: string, db = 0): Redis {
  const client = new Redis({
    host: redis.getHost(),
    port: redis.getMappedPort(6379),
    username: user,
    password,
    db,
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
  clients.push(client);
  return client;
}

beforeAll(async () => {
  network = await new Network().start();
  redis = await new GenericContainer(prodImage('redis'))
    .withNetwork(network)
    .withNetworkAliases('redis')
    .withUser('999:999')
    .withEnvironment({ ...PASSWORDS, REDIS_MAXMEMORY: '64mb' })
    .withCommand(redisCommand())
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.quit().catch(() => undefined)));
  await redis?.stop();
  await network?.stop();
});

describe('Redis users (SEC-11)', () => {
  it('runs a BullMQ job and the Bot Center commands as the botcenter user', async () => {
    const connection = connect('botcenter', PASSWORDS.REDIS_BOTCENTER_PASSWORD);
    const queue = new Queue('acl-test', { connection });
    const worker = new Worker('acl-test', async (job) => (job.data as { n: number }).n * 2, {
      connection: connect('botcenter', PASSWORDS.REDIS_BOTCENTER_PASSWORD),
    });
    try {
      const done = new Promise<unknown>((resolve, reject) => {
        worker.on('completed', (_job, result) => resolve(result));
        worker.on('failed', (_job, error) => reject(error));
        worker.on('error', reject);
      });
      await queue.add('double', { n: 21 });
      expect(await done).toBe(42);
      expect(await queue.getJobCounts('failed')).toEqual({ failed: 0 });
    } finally {
      await worker.close();
      await queue.close();
    }
    const client = connect('botcenter', PASSWORDS.REDIS_BOTCENTER_PASSWORD);
    await client.client('SETNAME', 'botcenter:client');
    expect(await client.set('bc:test', '1', 'PX', 10_000, 'NX')).toBe('OK');
    expect(
      await client.eval("return redis.call('PEXPIRE', KEYS[1], ARGV[1])", 1, 'bc:test', '5000'),
    ).toBe(1);
    expect(await client.publish('bc:connect:events:x', 'hello')).toBe(0);
    await expect(client.get('evolution:instance:x')).rejects.toThrow(/NOPERM/);
    await expect(client.flushall()).rejects.toThrow(/NOPERM/);
  });

  it('gives the evolution user its cache commands on evolution:* only', async () => {
    const evolution = connect('evolution', PASSWORDS.REDIS_EVOLUTION_PASSWORD, 1);
    expect(await evolution.setex('evolution:instance:a', 60, '{}')).toBe('OK');
    expect(await evolution.get('evolution:instance:a')).toBe('{}');
    expect(await evolution.exists('evolution:instance:a')).toBe(1);
    expect(await evolution.hset('evolution:auth:a', 'creds', '{}')).toBe(1);
    expect(await evolution.hget('evolution:auth:a', 'creds')).toBe('{}');
    expect(await evolution.hdel('evolution:auth:a', 'creds')).toBe(1);
    const [, keys] = await evolution.scan('0', 'MATCH', 'evolution:*', 'COUNT', 100);
    expect(keys).toContain('evolution:instance:a');
    expect(await evolution.del('evolution:instance:a')).toBe(1);

    // A compromised Evolution cannot touch the queues, the key cache, or the connect events.
    await expect(evolution.select(0)).resolves.toBe('OK');
    await expect(evolution.get('bc:apikey:abc')).rejects.toThrow(/NOPERM/);
    await expect(evolution.set('bc:apikey:abc', '{}')).rejects.toThrow(/NOPERM/);
    await expect(evolution.lpush('bull:inbound:wait', 'x')).rejects.toThrow(/NOPERM/);
    await expect(evolution.publish('bc:connect:events:x', 'qr')).rejects.toThrow(/NOPERM/);
    await expect(evolution.flushall()).rejects.toThrow(/NOPERM/);
    await expect(evolution.call('CONFIG', 'GET', 'requirepass')).rejects.toThrow(/NOPERM/);
    await expect(evolution.eval("return redis.call('GET', 'bc:apikey:abc')", 0)).rejects.toThrow(
      /NOPERM/,
    );
  });

  it('gives the metrics user INFO only', async () => {
    const metrics = connect('metrics', PASSWORDS.REDIS_METRICS_PASSWORD);
    expect(await metrics.info('memory')).toContain('used_memory:');
    await expect(metrics.get('evolution:instance:a')).rejects.toThrow(/NOPERM/);
    await expect(metrics.get('bc:test')).rejects.toThrow(/NOPERM/);
  });

  it('keeps the default user for the health check, and no password in the process arguments', async () => {
    const ping = await redis.exec(['sh', '-c', 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping']);
    expect(ping.output.trim()).toBe('PONG');
    const cmdline = await redis.exec(['sh', '-c', "tr '\\0' ' ' < /proc/1/cmdline"]);
    for (const password of Object.values(PASSWORDS)) {
      expect(cmdline.output).not.toContain(password);
    }
  });
});

/** The `prometheus.exporter.redis` block of the production config.alloy. */
function exporterBlock(): string {
  const config = readRepoFile('infra/observability/alloy/config.alloy');
  const start = config.indexOf('prometheus.exporter.redis "redis" {');
  expect(start, 'prometheus.exporter.redis in config.alloy').toBeGreaterThan(-1);
  return config.slice(start, config.indexOf('\n}\n', start) + 3);
}

describe('Redis exporter of Alloy (open problem: Redis memory)', () => {
  it('reads the memory of Redis as the metrics user', async () => {
    const alloy = await new GenericContainer(prodImage('alloy'))
      .withNetwork(network)
      .withUser('473:473')
      .withEnvironment({ REDIS_METRICS_PASSWORD: PASSWORDS.REDIS_METRICS_PASSWORD })
      .withCopyContentToContainer([{ content: exporterBlock(), target: '/etc/alloy/test.alloy' }])
      .withCommand([
        'run',
        '/etc/alloy/test.alloy',
        '--storage.path=/tmp/alloy',
        '--server.http.listen-addr=0.0.0.0:12345',
        '--disable-reporting',
      ])
      .withExposedPorts(12345)
      .withWaitStrategy(Wait.forHttp('/-/ready', 12345))
      .start();
    try {
      const url = `http://${alloy.getHost()}:${alloy.getMappedPort(12345)}/api/v0/component/prometheus.exporter.redis.redis/metrics`;
      const text = await (await fetch(url)).text();
      expect(text).toMatch(/^redis_up 1$/m);
      expect(text).toMatch(/^redis_memory_used_bytes \d/m);
      expect(text).toMatch(/^redis_memory_max_bytes 6.71088(64)?e\+07$/m);
    } finally {
      await alloy.stop();
    }
  });
});
