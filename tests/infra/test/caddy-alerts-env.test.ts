import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readEnvFile, readRepoFile, readYaml, repoPath } from './helpers/repo.js';

describe('Caddyfile', () => {
  const caddyfile = readRepoFile('infra/caddy/Caddyfile');

  it('forwards only /v1/* and /health/* to the API and answers 404 for the rest', () => {
    const handles = [...caddyfile.matchAll(/^\thandle( [^{]*)?\{/gm)].map((m) =>
      (m[1] ?? '').trim(),
    );
    expect(handles).toEqual(['@suspicious', '@connect_events', '/v1/*', '/health/*', '']);
    expect(caddyfile).not.toMatch(/handle \/internal|handle \/metrics/);
    expect(caddyfile).toContain(
      'respond `{"type":"about:blank","title":"Not Found","status":404}` 404',
    );
  });

  it('limits the request body to 2 MiB and streams the SSE route without a buffer', () => {
    expect(caddyfile).toMatch(/request_body \{\n\t\tmax_size 2MB\n\t\}/);
    expect(caddyfile).toContain('flush_interval -1');
  });

  it('takes the client IP from CF-Connecting-IP of the Cloudflare ranges only', () => {
    expect(caddyfile).toContain('import /etc/caddy/cloudflare-ips.caddy');
    expect(caddyfile).toContain('client_ip_headers CF-Connecting-IP');
    const snippet = readRepoFile('infra/caddy/cloudflare-ips.caddy');
    expect(snippet).toMatch(/^trusted_proxies static( [0-9a-f.:]+\/\d+){15,}$/m);
  });
});

describe('alerts.yml', () => {
  interface Rule {
    alert: string;
    expr: string;
  }
  const rules = readYaml<{ groups: { rules: Rule[] }[] }>(
    'infra/observability/prometheus/alerts.yml',
  ).groups.flatMap((group) => group.rules);

  it('has the alerts of the architecture', () => {
    const names = rules.map((rule) => rule.alert);
    for (const name of [
      'InstanceDisconnected',
      'OutboundQueueDelayHigh',
      'SendFailureRateHigh',
      'InstanceSendFailureRateHigh',
      'InboundJobsFailed',
      'WebhookDeliveryFailuresHigh',
      'HostDiskUsageHigh',
      'BackupMissing',
      'HostCpuHigh',
      'HostMemoryHigh',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('uses only the agreed application metric names', () => {
    const agreed = new Set([
      'botcenter_instances',
      'botcenter_instance_incidents',
      'botcenter_queue_delay_seconds',
      'botcenter_queue_size',
      'botcenter_messages_total',
      'botcenter_instance_messages_total',
      'botcenter_webhook_deliveries_total',
      'botcenter_rate_limit_denied_total',
      'botcenter_backup_last_run_success',
      'botcenter_backup_last_success_timestamp_seconds',
      'botcenter_restore_test_last_success_timestamp_seconds',
    ]);
    const used = rules.flatMap((rule) => rule.expr.match(/\bbotcenter_[a-z_]+/g) ?? []);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(agreed, name).toContain(name);
  });
});

describe('env templates', () => {
  const dir = repoPath('infra/env');
  const templates = readdirSync(dir).filter((name) => name.endsWith('.env.example'));
  const generator = readRepoFile('infra/scripts/gen-secrets.sh');

  it('has a generator for every __TOKEN__', () => {
    for (const name of templates) {
      for (const [, token] of readRepoFile('infra/env', name).matchAll(/__([A-Z0-9_]+)__/g)) {
        expect(generator, `${name}: ${token}`).toContain(`[${token}]=`);
      }
    }
  });

  it('gives the API every required variable of apps/api/src/config/env.ts', () => {
    const api = readEnvFile(readRepoFile('infra/env/api.env.example'));
    for (const name of [
      'DATABASE_URL',
      'REDIS_URL',
      'API_KEY_PEPPER',
      'DATA_ENCRYPTION_KEY',
      'EVOLUTION_URL',
      'EVOLUTION_API_KEY',
      'EVOLUTION_WEBHOOK_SECRET',
      'INTERNAL_WEBHOOK_BASE_URL',
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ]) {
      expect(api.has(name), name).toBe(true);
    }
    // The owner role of the database is only in migrate.env.
    expect(api.has('DATABASE_URL_MIGRATE')).toBe(false);
    expect(api.get('DATABASE_URL')).toContain('botcenter_app:');
  });

  /**
   * The keys of `EnvSchema` in apps/api/src/config/env.ts, read from the source (no build needed). Other
   * slices add keys, so the test never uses a fixed list.
   */
  function envSchemaKeys(): string[] {
    const source = readRepoFile('apps/api/src/config/env.ts');
    const start = source.indexOf('export const EnvSchema = z.object({');
    const end = source.indexOf('\n});', start);
    expect(start, 'EnvSchema in env.ts').toBeGreaterThan(-1);
    const body = source.slice(start, end);
    return [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]!);
  }

  /** The variables that compose.prod.yml sets in `environment:` of the api and worker services. */
  function composeAppVariables(): Set<string> {
    const compose = readYaml<{ services: Record<string, { environment?: Record<string, string> }> }>(
      'infra/compose/compose.prod.yml',
    );
    return new Set(
      ['api', 'worker'].flatMap((name) => Object.keys(compose.services[name]?.environment ?? {})),
    );
  }

  it('lists every variable of the env schema in api.env.example or in compose.prod.yml (ARCH-05, ARCH-21)', () => {
    const keys = envSchemaKeys();
    expect(keys.length).toBeGreaterThan(30);
    const api = readEnvFile(readRepoFile('infra/env/api.env.example'));
    const compose = composeAppVariables();
    const missing = keys.filter((key) => !api.has(key) && !compose.has(key));
    expect(missing, 'add these names to infra/env/api.env.example').toEqual([]);
  });

  it('lists no variable in api.env.example that the env schema does not know', () => {
    const keys = new Set(envSchemaKeys());
    const unknown = [...readEnvFile(readRepoFile('infra/env/api.env.example')).keys()].filter(
      (name) => !keys.has(name),
    );
    expect(unknown).toEqual([]);
  });

  it('sets the browser origins of the connect stream in production (ARCH-05)', () => {
    const api = readEnvFile(readRepoFile('infra/env/api.env.example'));
    expect(api.get('CONNECT_ALLOWED_ORIGINS')).toBe('https://CHANGE_ME');
    expect(api.get('EXTERNAL_HTTP_ALLOW_PRIVATE')).toBe('false');
  });

  it('uses the same Evolution key in the API and in the Evolution container', () => {
    const api = readEnvFile(readRepoFile('infra/env/api.env.example'));
    const evolution = readEnvFile(readRepoFile('infra/env/evolution.env.example'));
    expect(api.get('EVOLUTION_API_KEY')).toBe(evolution.get('AUTHENTICATION_API_KEY'));
  });
});
