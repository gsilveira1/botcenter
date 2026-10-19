import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readEnvFile, repoPath, run, startRecorder } from './helpers/repo.js';

const temporary: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `botcenter-${prefix}-`));
  temporary.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

describe('gen-secrets.sh', () => {
  const script = repoPath('infra/scripts/gen-secrets.sh');

  it('writes every env file with mode 600 and one value for each secret', async () => {
    const target = tempDir('secrets');
    const result = await run(script, ['--target-dir', target]);
    expect(result.code, result.stderr).toBe(0);

    const files = readdirSync(target).filter((name) => name.endsWith('.env'));
    const templates = readdirSync(repoPath('infra/env')).filter((n) => n.endsWith('.env.example'));
    expect(files.sort()).toEqual(templates.map((n) => n.replace(/\.example$/, '')).sort());
    for (const name of files) {
      expect(statSync(path.join(target, name)).mode & 0o777, name).toBe(0o600);
    }
    expect(statSync(target).mode & 0o777).toBe(0o700);

    const env = (name: string) => readEnvFile(readFileSync(path.join(target, name), 'utf8'));
    const redis = env('redis.env').get('REDIS_PASSWORD')!;
    expect(redis).toMatch(/^[0-9a-f]{64}$/);
    expect(env('api.env').get('REDIS_URL')).toBe(`redis://:${redis}@redis:6379/0`);
    expect(env('evolution.env').get('CACHE_REDIS_URI')).toBe(`redis://:${redis}@redis:6379/1`);
    expect(env('api.env').get('EVOLUTION_API_KEY')).toBe(
      env('evolution.env').get('AUTHENTICATION_API_KEY'),
    );
    expect(Buffer.from(env('api.env').get('DATA_ENCRYPTION_KEY')!, 'base64')).toHaveLength(32);
    expect(env('api.env').get('API_KEY_PEPPER')).not.toBe(redis);
    // The script never prints a secret.
    expect(result.stdout).not.toContain(redis);
  });

  it('changes nothing on a second run and stops when only some files exist', async () => {
    const target = tempDir('secrets-again');
    expect((await run(script, ['--target-dir', target])).code).toBe(0);
    const before = readFileSync(path.join(target, 'api.env'), 'utf8');

    const again = await run(script, ['--target-dir', target]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('Nothing to do');
    expect(readFileSync(path.join(target, 'api.env'), 'utf8')).toBe(before);

    rmSync(path.join(target, 'redis.env'));
    const partial = await run(script, ['--target-dir', target]);
    expect(partial.code).toBe(1);
    expect(partial.stderr).toContain('New secrets would not match the old ones');
    expect(readFileSync(path.join(target, 'api.env'), 'utf8')).toBe(before);
  });
});

describe('host scripts: alerts', () => {
  let discord: Awaited<ReturnType<typeof startRecorder>>;
  beforeAll(async () => {
    discord = await startRecorder();
  });
  afterEach(() => {
    discord.requests.length = 0;
  });
  afterAll(async () => {
    await discord.close();
  });

  /** A fake `docker` that knows no container: `docker ps` prints nothing. */
  function fakeDockerBin(): string {
    const bin = tempDir('bin');
    writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(bin, 'docker'), 0o755);
    return bin;
  }

  it('backup.sh sends a Discord alert and writes a failed metric when the dump fails', async () => {
    const work = tempDir('backup');
    const resticEnv = path.join(work, 'restic.env');
    writeFileSync(resticEnv, 'RESTIC_REPOSITORY=s3:http://127.0.0.1:1/none\n');
    const result = await run(repoPath('infra/backup/backup.sh'), [], {
      PATH: `${fakeDockerBin()}:${process.env.PATH}`,
      RESTIC_ENV_FILE: resticEnv,
      BACKUP_HOST_TAG: 'test-host',
      BACKUP_WORK_DIR: path.join(work, 'work'),
      METRICS_DIR: path.join(work, 'metrics'),
      DISK_ALERT_PERCENT: '100',
      ALERT_DISCORD_WEBHOOK_URL: `${discord.url}/discord`,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no running container for the service 'postgres'");
    expect(discord.requests).toHaveLength(1);
    const payload = JSON.parse(discord.requests[0]!.body) as { content: string };
    expect(payload.content).toContain(
      '[botcenter test-host] backup: the backup FAILED at the step',
    );
    expect(payload.content).toContain("'dump'");
    const metrics = readFileSync(path.join(work, 'metrics', 'botcenter_backup.prom'), 'utf8');
    expect(metrics).toMatch(/^botcenter_backup_last_run_success 0$/m);
    expect(metrics).toMatch(/^botcenter_backup_last_success_timestamp_seconds 0$/m);
  });

  it('backup.sh stops with a clear message when a variable is missing', async () => {
    const result = await run(repoPath('infra/backup/backup.sh'), [], {
      RESTIC_ENV_FILE: '',
      BACKUP_HOST_TAG: '',
      BACKUP_WORK_DIR: '',
      METRICS_DIR: tempDir('metrics'),
      ALERT_DISCORD_WEBHOOK_URL: `${discord.url}/discord`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'these variables are not set: RESTIC_ENV_FILE BACKUP_HOST_TAG BACKUP_WORK_DIR',
    );
    expect(discord.requests).toHaveLength(1);
  });

  it('disk-check.sh alerts once above the threshold and again only after the repeat interval', async () => {
    const state = tempDir('state');
    const env = {
      DISK_ALERT_PERCENT: '1',
      STATE_DIR: state,
      ALERT_DISCORD_WEBHOOK_URL: `${discord.url}/discord`,
      BACKUP_HOST_TAG: 'test-host',
    };
    const first = await run(repoPath('infra/backup/disk-check.sh'), [], env);
    expect(first.code).toBe(1);
    const alerts = discord.requests.length;
    expect(alerts).toBeGreaterThanOrEqual(1);
    expect(discord.requests[0]!.body).toContain('disk usage of / is');

    const second = await run(repoPath('infra/backup/disk-check.sh'), [], env);
    expect(second.code).toBe(1);
    expect(discord.requests).toHaveLength(alerts);

    const below = await run(repoPath('infra/backup/disk-check.sh'), [], {
      ...env,
      DISK_ALERT_PERCENT: '100',
    });
    expect(below.code).toBe(0);
    expect(readdirSync(state)).toEqual([]);
  });
});

describe('firewall-cloudflare.sh --dry-run', () => {
  const v4 = Array.from({ length: 12 }, (_, i) => `10.${i}.0.0/16`).join('\n');
  const v6 = Array.from({ length: 6 }, (_, i) => `2001:db8:${i}::/48`).join('\n');

  function lists(v4Content: string, v6Content: string) {
    const dir = tempDir('cf');
    writeFileSync(path.join(dir, 'v4'), `${v4Content}\n`);
    writeFileSync(path.join(dir, 'v6'), `${v6Content}\n`);
    return {
      CF_IPS_V4_URL: `file://${dir}/v4`,
      CF_IPS_V6_URL: `file://${dir}/v6`,
      PUBLIC_INTERFACE: 'eth0',
      CADDY_SNIPPET: path.join(dir, 'snippet.caddy'),
    };
  }

  it('allows 443 only from the listed ranges and writes the Caddy snippet', async () => {
    const result = await run(
      repoPath('infra/host/firewall-cloudflare.sh'),
      ['--dry-run'],
      lists(v4, v6),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'iptables -A BOTCENTER-CF -s 10.0.0.0/16 -p tcp -m conntrack --ctorigdstport 443 -j RETURN',
    );
    expect(result.stdout).toContain(
      'iptables -A BOTCENTER-CF -p tcp -m conntrack --ctorigdstport 443 -j DROP',
    );
    expect(result.stdout).toContain(
      'ip6tables -A BOTCENTER-CF -s 2001:db8:0::/48 -p tcp -m conntrack --ctorigdstport 443 -j RETURN',
    );
    expect(result.stdout).not.toContain('--ctorigdstport 80 ');
    expect(result.stdout).toMatch(/^trusted_proxies static 10\.0\.0\.0\/16 .* 2001:db8:5::\/48$/m);
  });

  it('limits the egress of the Evolution API container (SEC-01)', async () => {
    const result = await run(
      repoPath('infra/host/firewall-cloudflare.sh'),
      ['--dry-run'],
      lists(v4, v6),
    );
    expect(result.code, result.stderr).toBe(0);
    const evo = result.stdout.split('\n').filter((line) => line.includes('BOTCENTER-EVO'));
    expect(evo).toEqual([
      'iptables -N BOTCENTER-EVO',
      'iptables -F BOTCENTER-EVO',
      'iptables -A BOTCENTER-EVO -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN',
      'iptables -A BOTCENTER-EVO -d 10.203.1.10 -p tcp --dport 5432 -j RETURN',
      'iptables -A BOTCENTER-EVO -d 10.203.1.11 -p tcp --dport 6379 -j RETURN',
      'iptables -A BOTCENTER-EVO -d 10.203.1.20 -p tcp --dport 3000 -j RETURN',
      'iptables -A BOTCENTER-EVO -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited',
      'iptables -A BOTCENTER-EVO -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited',
      'iptables -A BOTCENTER-EVO -d 172.16.0.0/12 -j REJECT --reject-with icmp-admin-prohibited',
      'iptables -A BOTCENTER-EVO -d 192.168.0.0/16 -j REJECT --reject-with icmp-admin-prohibited',
      'iptables -A BOTCENTER-EVO -d 100.64.0.0/10 -j REJECT --reject-with icmp-admin-prohibited',
      'iptables -A BOTCENTER-EVO -j RETURN',
      'iptables -I DOCKER-USER 1 -s 10.203.1.30 -j BOTCENTER-EVO',
      'iptables -I DOCKER-USER 1 -s 10.203.2.30 -j BOTCENTER-EVO',
    ]);
    // IPv4 only: the networks of the stack have no IPv6.
    expect(result.stdout).not.toContain('ip6tables -N BOTCENTER-EVO');
  });

  it('opens port 80 too with --allow-http', async () => {
    const result = await run(
      repoPath('infra/host/firewall-cloudflare.sh'),
      ['--dry-run', '--allow-http'],
      lists(v4, v6),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('--ctorigdstport 80 -j DROP');
  });

  it('keeps the current rules when a list has a bad line or too few ranges', async () => {
    const bad = await run(
      repoPath('infra/host/firewall-cloudflare.sh'),
      ['--dry-run'],
      lists(`${v4}\n1.2.3.4/33`, v6),
    );
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("the line '1.2.3.4/33'");

    const short = await run(
      repoPath('infra/host/firewall-cloudflare.sh'),
      ['--dry-run'],
      lists('10.0.0.0/8', v6),
    );
    expect(short.code).toBe(1);
    expect(short.stderr).toContain('has only 1 ranges (minimum 10)');
  });
});
