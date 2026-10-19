import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALPINE_IMAGE } from './helpers/images.js';
import { readRepoFile } from './helpers/repo.js';

/**
 * firewall-cloudflare.sh with real iptables (nf_tables) in a container with NET_ADMIN only: the network
 * namespace of the container stands for the host. The test starts the script before "Docker" (no
 * DOCKER-USER chain), then does what dockerd does at start (it keeps DOCKER-USER and adds the jump from
 * FORWARD), and checks that the rules stay.
 */
let container: StartedTestContainer;

async function sh(command: string): Promise<{ code: number; output: string }> {
  const result = await container.exec(['sh', '-c', command]);
  return { code: result.exitCode, output: result.output };
}

const ENV =
  'PUBLIC_INTERFACE=eth0 CADDY_SNIPPET=/opt/botcenter/infra/caddy/cloudflare-ips.caddy FIREWALL_BACKENDS=docker-user';

beforeAll(async () => {
  container = await new GenericContainer(ALPINE_IMAGE)
    .withAddedCapabilities('NET_ADMIN')
    .withCommand(['sleep', 'infinity'])
    .withCopyContentToContainer([
      {
        content: readRepoFile('infra/host/firewall-cloudflare.sh'),
        target: '/opt/botcenter/infra/host/firewall-cloudflare.sh',
        mode: 0o755,
      },
      {
        content: readRepoFile('infra/backup/lib.sh'),
        target: '/opt/botcenter/infra/backup/lib.sh',
      },
      {
        content: readRepoFile('infra/caddy/cloudflare-ips.caddy'),
        target: '/opt/botcenter/infra/caddy/cloudflare-ips.caddy',
      },
    ])
    .start();
  const install = await sh('apk add --no-cache -q bash iptables ip6tables');
  expect(install.code, install.output).toBe(0);
});

afterAll(async () => {
  await container?.stop();
});

describe('firewall-cloudflare.sh --offline (boot, before docker.service)', () => {
  it('creates DOCKER-USER and the two chains when Docker has not started yet', async () => {
    expect((await sh('iptables -S DOCKER-USER')).code).not.toBe(0);
    const result = await sh(`${ENV} /opt/botcenter/infra/host/firewall-cloudflare.sh --offline`);
    expect(result.code, result.output).toBe(0);
    const rules = (await sh('iptables -S DOCKER-USER')).output;
    expect(rules).toContain('-A DOCKER-USER -j BOTCENTER-CF');
    expect(rules).toContain('-A DOCKER-USER -s 10.203.1.30/32 -j BOTCENTER-EVO');
    expect(rules).toContain('-A DOCKER-USER -s 10.203.2.30/32 -j BOTCENTER-EVO');
    const cf = (await sh('iptables -S BOTCENTER-CF')).output;
    expect(cf).toContain(
      '-A BOTCENTER-CF -s 173.245.48.0/20 -p tcp -m conntrack --ctorigdstport 443 -j RETURN',
    );
    expect(cf).toContain('-A BOTCENTER-CF -p tcp -m conntrack --ctorigdstport 443 -j DROP');
    const evo = (await sh('iptables -S BOTCENTER-EVO')).output;
    expect(evo).toContain(
      '-A BOTCENTER-EVO -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited',
    );
    expect((await sh('ip6tables -S DOCKER-USER')).output).toContain('-j BOTCENTER-CF');
  });

  it('keeps the rules when Docker starts, and a second run replaces them without duplicates', async () => {
    // dockerd at start: it keeps the chain DOCKER-USER and adds the jump from FORWARD.
    await sh('iptables -N DOCKER-USER 2>/dev/null; iptables -I FORWARD -j DOCKER-USER');
    expect((await sh('iptables -S DOCKER-USER')).output).toContain('-j BOTCENTER-CF');

    const again = await sh(`${ENV} /opt/botcenter/infra/host/firewall-cloudflare.sh --offline`);
    expect(again.code, again.output).toBe(0);
    const rules = (await sh('iptables -S DOCKER-USER')).output.split('\n');
    expect(rules.filter((line) => line.endsWith('-j BOTCENTER-CF'))).toHaveLength(1);
    expect(rules.filter((line) => line.endsWith('-j BOTCENTER-EVO'))).toHaveLength(2);
    expect(rules.some((line) => line.includes('-NEW'))).toBe(false);
  });
});
