import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prodImage } from './helpers/images.js';

/**
 * SEC-07 proof: Alloy mounts the /proc of the host for the node exporter. /proc/<pid>/environ of a root
 * process (the Evolution container gets its secrets in the environment) is readable for a root reader
 * without capabilities, but not for the uid of the Alloy image (473). A "secret holder" container
 * stands for Evolution; the readers use the Alloy image with the mounts and options of compose.prod.yml.
 */
const MARKER = 'SEC07_MARKER_SECRET_VALUE';
let holder: StartedTestContainer;

async function readEnvironOfHost(user: string): Promise<string> {
  const reader = await new GenericContainer(prodImage('alloy'))
    .withUser(user)
    .withEntrypoint(['sleep'])
    .withCommand(['60'])
    .withBindMounts([{ source: '/proc', target: '/host/proc', mode: 'ro' }])
    .withDroppedCapabilities('ALL')
    .withSecurityOpt('no-new-privileges:true')
    .start();
  try {
    const result = await reader.exec([
      'sh',
      '-c',
      `cat /host/proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c ${MARKER} || true`,
    ]);
    return result.output.trim();
  } finally {
    await reader.stop();
  }
}

beforeAll(async () => {
  holder = await new GenericContainer(prodImage('alloy'))
    .withUser('0:0')
    .withEnvironment({ SECRET: MARKER })
    // As compose.prod.yml: the Evolution container runs as root with no capability.
    .withDroppedCapabilities('ALL')
    .withEntrypoint(['sleep'])
    .withCommand(['300'])
    .start();
});

afterAll(async () => {
  await holder?.stop();
});

describe('Alloy and /proc of the host (SEC-07)', () => {
  it('a root reader without capabilities can read the environment of a root container', async () => {
    expect(Number(await readEnvironOfHost('0:0'))).toBeGreaterThan(0);
  });

  it('the uid of the Alloy image (473) cannot read it', async () => {
    expect(await readEnvironOfHost('473:473')).toBe('0');
  });
});
