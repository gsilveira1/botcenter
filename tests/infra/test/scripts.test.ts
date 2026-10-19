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
    // SEC-11: one Redis user for each client; the admin password stays in redis.env.
    const botcenter = env('redis.env').get('REDIS_BOTCENTER_PASSWORD')!;
    const evolution = env('redis.env').get('REDIS_EVOLUTION_PASSWORD')!;
    expect(new Set([redis, botcenter, evolution]).size).toBe(3);
    expect(env('api.env').get('REDIS_URL')).toBe(`redis://botcenter:${botcenter}@redis:6379/0`);
    expect(env('evolution.env').get('CACHE_REDIS_URI')).toBe(
      `redis://evolution:${evolution}@redis:6379/1`,
    );
    expect(env('alloy.env').get('REDIS_METRICS_PASSWORD')).toBe(
      env('redis.env').get('REDIS_METRICS_PASSWORD'),
    );
    for (const name of ['api.env', 'evolution.env', 'alloy.env']) {
      expect(readFileSync(path.join(target, name), 'utf8'), name).not.toContain(redis);
    }
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

  it('disk-check.sh writes the disk metrics of the host for Alloy (SEC-07: no host root mount)', async () => {
    const metrics = tempDir('disk-metrics');
    const result = await run(repoPath('infra/backup/disk-check.sh'), [], {
      DISK_ALERT_PERCENT: '100',
      STATE_DIR: tempDir('disk-state'),
      METRICS_DIR: metrics,
      ALERT_DISCORD_WEBHOOK_URL: `${discord.url}/discord`,
    });
    expect(result.code, result.stderr).toBe(0);
    const text = readFileSync(path.join(metrics, 'botcenter_host_disk.prom'), 'utf8');
    expect(text).toMatch(/^botcenter_host_filesystem_size_bytes\{mountpoint="\/"\} [1-9]\d*$/m);
    expect(text).toMatch(/^botcenter_host_filesystem_avail_bytes\{mountpoint="\/"\} \d+$/m);
  });

  it('disk-check.sh alerts once above the threshold and again only after the repeat interval', async () => {
    const state = tempDir('state');
    const env = {
      DISK_ALERT_PERCENT: '1',
      STATE_DIR: state,
      METRICS_DIR: tempDir('disk-check-metrics'),
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

  it('--offline reads the last known ranges from the Caddy snippet, without network', async () => {
    const env = lists(v4, v6);
    writeFileSync(
      env.CADDY_SNIPPET,
      'trusted_proxies static 10.0.0.0/16 10.1.0.0/16 10.2.0.0/16 10.3.0.0/16 10.4.0.0/16 10.5.0.0/16 10.6.0.0/16 10.7.0.0/16 10.8.0.0/16 10.9.0.0/16 2001:db8:0::/48 2001:db8:1::/48 2001:db8:2::/48 2001:db8:3::/48 2001:db8:4::/48\n',
    );
    const result = await run(
      repoPath('infra/host/firewall-cloudflare.sh'),
      ['--dry-run', '--offline'],
      {
        ...env,
        // No fetch in the offline mode: these URLs do not exist.
        CF_IPS_V4_URL: 'file:///nonexistent/v4',
        CF_IPS_V6_URL: 'file:///nonexistent/v6',
      },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('iptables -N DOCKER-USER');
    expect(result.stdout).toContain(
      'iptables -A BOTCENTER-CF -s 10.9.0.0/16 -p tcp -m conntrack --ctorigdstport 443 -j RETURN',
    );
    expect(result.stdout).toContain(
      'ip6tables -A BOTCENTER-CF -s 2001:db8:4::/48 -p tcp -m conntrack --ctorigdstport 443 -j RETURN',
    );
    expect(result.stdout).toContain('iptables -N BOTCENTER-EVO');
    // The offline mode does not write the snippet.
    expect(result.stdout).not.toContain('trusted_proxies static');
  });

  it('--offline falls back to the repository snippet when the host copy is missing', async () => {
    const env = lists(v4, v6);
    const result = await run(
      repoPath('infra/host/firewall-cloudflare.sh'),
      ['--dry-run', '--offline'],
      {
        ...env,
        CADDY_SNIPPET: '/nonexistent/cloudflare-ips.caddy',
      },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'iptables -A BOTCENTER-CF -s 173.245.48.0/20 -p tcp -m conntrack --ctorigdstport 443 -j RETURN',
    );
  });

  it('applies the rules before Docker starts after a boot (systemd unit)', () => {
    const unit = readFileSync(
      repoPath('infra/host/systemd/botcenter-firewall-boot.service'),
      'utf8',
    );
    expect(unit).toMatch(/^Before=.*\bdocker\.service\b/m);
    expect(unit).toMatch(/^WantedBy=docker\.service$/m);
    expect(unit).toMatch(/^DefaultDependencies=no$/m);
    expect(unit).toMatch(
      /^ExecStart=\/opt\/botcenter\/infra\/host\/firewall-cloudflare\.sh --offline$/m,
    );
    expect(unit).toMatch(/^RemainAfterExit=yes$/m);
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

describe('deploy.sh and the release workflow (SEC-12)', () => {
  const digest = 'a'.repeat(64);
  function envDir(repository?: string): string {
    const dir = tempDir('deploy-env');
    writeFileSync(
      path.join(dir, 'compose.env'),
      `${repository ? `BOTCENTER_IMAGE_REPOSITORY=${repository}\n` : ''}BOTCENTER_IMAGE=old\n`,
    );
    return dir;
  }
  const deploy = (dir: string, tag: string, image: string) =>
    run(repoPath('infra/scripts/deploy.sh'), [tag, image], { BOTCENTER_ENV_DIR: dir });

  it('refuses an image of another owner or repository', async () => {
    const dir = envDir('ghcr.io/acme/botcenter-api');
    const result = await deploy(
      dir,
      'v1.2.3',
      `ghcr.io/attacker/botcenter-api:v1.2.3@sha256:${digest}`,
    );
    expect(result.code).toBe(64);
    expect(result.stderr).toContain(
      'the image must be ghcr.io/acme/botcenter-api:v1.2.3@sha256:<digest>',
    );
  });

  it('refuses an image tag that is not the release tag', async () => {
    const dir = envDir('ghcr.io/acme/botcenter-api');
    const result = await deploy(
      dir,
      'v1.2.3',
      `ghcr.io/acme/botcenter-api:v1.2.2@sha256:${digest}`,
    );
    expect(result.code).toBe(64);
  });

  it('stops when compose.env does not pin the image repository', async () => {
    const result = await deploy(
      envDir(),
      'v1.2.3',
      `ghcr.io/acme/botcenter-api:v1.2.3@sha256:${digest}`,
    );
    expect(result.code).toBe(64);
    expect(result.stderr).toContain('BOTCENTER_IMAGE_REPOSITORY');
  });

  it('scans the image before the push and verifies the attestation before the deploy', () => {
    const release = readFileSync(repoPath('.github/workflows/release.yml'), 'utf8');
    const scan = release.indexOf('name: Trivy scan of the local image');
    const push = release.indexOf('name: Push the scanned image');
    const load = release.indexOf('load: true');
    expect(load).toBeGreaterThan(-1);
    expect(scan).toBeGreaterThan(load);
    expect(push).toBeGreaterThan(scan);
    expect(release.slice(0, scan)).not.toMatch(/push: true/);
    expect(release).toContain('actions/attest-build-provenance@');
    expect(release).toContain(
      'gh attestation verify "oci://${IMAGE}" --repo "${GITHUB_REPOSITORY}"',
    );
    expect(release).toContain('ghcr\\.io/${OWNER}/botcenter-api:${TAG}@sha256:[0-9a-f]{64}$');
  });
});

describe('backup.sh retention (SEC-13)', () => {
  /** A fake `docker`: one postgres container, a dump of 4 KiB, and a log of each `docker run`. */
  function fakeDocker(log: string): string {
    const bin = tempDir('bin-backup');
    writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh
case "$1" in
  ps) echo postgres-id ;;
  exec)
    case " $* " in
      *" pg_dump "*) head -c 4096 /dev/zero ;;
      *) cat >/dev/null ;;
    esac ;;
  run) echo "$*" >>'${log}' ;;
esac
exit 0
`,
    );
    chmodSync(path.join(bin, 'docker'), 0o755);
    return bin;
  }

  it('forgets only snapshots older than the bucket lock, without a repack, with the retention key', async () => {
    const work = tempDir('backup-retention');
    const log = path.join(work, 'docker-run.log');
    writeFileSync(path.join(work, 'restic.env'), 'RESTIC_REPOSITORY=s3:http://127.0.0.1:1/none\n');
    writeFileSync(
      path.join(work, 'retention.env'),
      'RESTIC_REPOSITORY=s3:http://127.0.0.1:1/none\n',
    );
    const result = await run(repoPath('infra/backup/backup.sh'), [], {
      PATH: `${fakeDocker(log)}:${process.env.PATH}`,
      RESTIC_ENV_FILE: path.join(work, 'restic.env'),
      RESTIC_RETENTION_ENV_FILE: path.join(work, 'retention.env'),
      RESTIC_HOST_CACHE_DIR: path.join(work, 'cache'),
      BACKUP_HOST_TAG: 'test-host',
      BACKUP_WORK_DIR: path.join(work, 'work'),
      METRICS_DIR: path.join(work, 'metrics'),
      DISK_ALERT_PERCENT: '100',
      BACKUP_CHECK_WEEKDAY: '9',
      ALERT_DISCORD_WEBHOOK_URL: '',
    });
    expect(result.code, result.stderr).toBe(0);
    const runs = readFileSync(log, 'utf8').trim().split('\n');
    const backup = runs.find((line) => / backup /.test(line))!;
    const forget = runs.find((line) => / forget /.test(line))!;
    expect(backup).toContain(`--env-file ${path.join(work, 'restic.env')}`);
    expect(forget).toContain(`--env-file ${path.join(work, 'retention.env')}`);
    expect(forget).toContain('--keep-within 35d');
    expect(forget).toContain('--prune --max-unused unlimited');
    expect(forget).not.toMatch(/--keep-daily/);
  });
});
