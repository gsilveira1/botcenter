import { describe, expect, it } from 'vitest';
import { readEnvFile, readRepoFile, readYaml } from './helpers/repo.js';

interface Service {
  image?: string;
  user?: string;
  ports?: string[];
  read_only?: boolean;
  cap_drop?: string[];
  cap_add?: string[];
  security_opt?: string[];
  volumes?: string[];
  networks?: string[] | Record<string, { ipv4_address?: string } | null>;
  command?: string[] | string;
  healthcheck?: { test?: unknown; disable?: boolean };
  depends_on?: Record<string, { condition: string }>;
  deploy?: { resources?: { limits?: { memory?: string } } };
  environment?: Record<string, string>;
  group_add?: string[];
  logging?: { driver?: string; options?: Record<string, string> };
  stop_grace_period?: string;
}
interface ComposeFile {
  services: Record<string, Service>;
  networks?: Record<
    string,
    { internal?: boolean; ipam?: { config?: { subnet: string; ip_range?: string }[] } }
  >;
}

/** The network names of a service (list or map form). */
function networkNames(service: Service): string[] {
  const networks = service.networks ?? [];
  return Array.isArray(networks) ? networks : Object.keys(networks);
}

/** The fixed IPv4 address of a service on a network. */
function addressOn(service: string, network: string): string | undefined {
  const networks = prod.services[service]!.networks;
  return networks && !Array.isArray(networks) ? networks[network]?.ipv4_address : undefined;
}

const prod = readYaml<ComposeFile>('infra/compose/compose.prod.yml');
const dev = readYaml<ComposeFile>('infra/compose/compose.dev.yml');
const cx22 = readYaml<ComposeFile>('infra/compose/compose.prod.cx22.yml');
const services = Object.entries(prod.services);

/** Parses a Compose memory value (`512M`, `1G`, `${API_MEMORY:-512M}`) to MiB. */
function memoryMiB(value: string): number {
  const match = /(\d+(?:\.\d+)?)([MG])\}?$/.exec(value);
  if (!match) throw new Error(`cannot parse the memory value ${value}`);
  return Number(match[1]) * (match[2] === 'G' ? 1024 : 1);
}

describe('compose.prod.yml', () => {
  it('has the services of the architecture and a one-shot migrate service', () => {
    expect(Object.keys(prod.services).sort()).toEqual(
      [
        'alloy',
        'api',
        'caddy',
        'evolution',
        'migrate',
        'postgres',
        'redis',
        'uptime-kuma',
        'worker',
      ].sort(),
    );
  });

  it('gives host ports to Caddy only', () => {
    const withPorts = services.filter(([, s]) => (s.ports ?? []).length > 0).map(([name]) => name);
    expect(withPorts).toEqual(['caddy']);
    // The Uptime Kuma UI is on the loopback interface of the host only.
    expect(prod.services.caddy!.ports).toEqual(['80:80', '443:443', '127.0.0.1:3001:3001']);
  });

  it('pins every image by digest, and the Evolution API by tag and digest', () => {
    for (const [name, service] of services) {
      if (name === 'api' || name === 'worker' || name === 'migrate') {
        expect(service.image).toMatch(/^\$\{BOTCENTER_IMAGE:\?/);
        continue;
      }
      expect(service.image, name).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
    expect(prod.services.evolution!.image).toMatch(
      /^evoapicloud\/evolution-api:v2\.3\.7@sha256:[0-9a-f]{64}$/,
    );
  });

  it('drops all capabilities and sets no-new-privileges on every service', () => {
    for (const [name, service] of services) {
      expect(service.cap_drop, name).toEqual(['ALL']);
      expect(service.security_opt, name).toContain('no-new-privileges:true');
    }
    expect(prod.services.caddy!.cap_add).toEqual(['NET_BIND_SERVICE']);
    const withCapAdd = services.filter(([, s]) => s.cap_add).map(([name]) => name);
    expect(withCapAdd).toEqual(['caddy']);
  });

  it('uses a read-only root file system everywhere except the Evolution API', () => {
    const writable = services.filter(([, s]) => s.read_only !== true).map(([name]) => name);
    expect(writable).toEqual(['evolution']);
  });

  it('runs the application, Caddy, PostgreSQL, and Redis as non-root users', () => {
    for (const name of ['api', 'worker', 'migrate', 'caddy', 'postgres', 'redis']) {
      expect(prod.services[name]!.user, name).toMatch(/^[1-9]\d*:[1-9]\d*$/);
    }
  });

  describe('Alloy least privilege (SEC-07)', () => {
    /** The host path of a bind mount (`/a:/b:ro`), or undefined for a named volume. */
    function hostPath(volume: string): string | undefined {
      const source = volume.split(':')[0]!;
      return source.startsWith('/') ? source : undefined;
    }

    it('mounts no host root, no Docker data, and no secret directory in any service', () => {
      for (const [name, service] of services) {
        for (const volume of service.volumes ?? []) {
          const source = hostPath(volume);
          if (!source) continue;
          expect(source, name).not.toBe('/');
          expect(source, name).not.toMatch(/^\/var\/lib\/docker(\/|$)/);
          expect(source, name).not.toMatch(/^\/etc\/botcenter\/?$/);
          expect(source, name).not.toMatch(/^\/(root|home)(\/|$)/);
        }
      }
    });

    it('runs Alloy as its image user with read-only mounts of the journal, /proc, /sys, and the text files only', () => {
      const alloy = prod.services.alloy!;
      expect(alloy.user).toBe('473:473');
      expect(alloy.group_add).toEqual([
        '${BOTCENTER_JOURNAL_GID:?Set BOTCENTER_JOURNAL_GID in compose.env}',
      ]);
      const hostMounts = (alloy.volumes ?? []).filter((volume) => hostPath(volume));
      expect(hostMounts.sort()).toEqual(
        [
          '/etc/machine-id:/etc/machine-id:ro',
          '/proc:/host/proc:ro',
          '/sys:/host/sys:ro',
          '/var/lib/botcenter/metrics:/host/textfile:ro',
          '/var/log/journal:/var/log/journal:ro',
        ].sort(),
      );
      const alloyConfig = readRepoFile('infra/observability/alloy/config.alloy');
      expect(alloyConfig).toContain('loki.source.journal');
      expect(alloyConfig).not.toContain('/var/lib/docker/containers');
      expect(alloyConfig).not.toContain('rootfs_path');
    });

    it('sends the container logs to journald with the Compose labels', () => {
      for (const [name, service] of services) {
        expect(service.logging?.driver, name).toBe('journald');
        expect(service.logging?.options?.labels, name).toBe(
          'com.docker.compose.service,com.docker.compose.project',
        );
      }
    });
  });

  it('mounts no Docker socket', () => {
    for (const [name, service] of services) {
      for (const volume of service.volumes ?? []) {
        expect(volume, name).not.toContain('docker.sock');
      }
    }
  });

  it('has a health check on every long-running service and a memory limit on every service', () => {
    for (const [name, service] of services) {
      expect(service.deploy?.resources?.limits?.memory, name).toBeDefined();
      if (name === 'migrate') {
        expect(service.healthcheck?.disable).toBe(true);
      } else {
        expect(service.healthcheck?.test, name).toBeDefined();
      }
    }
  });

  it('has the memory split of the plan for the 8 GB host', () => {
    const limit = (name: string) =>
      memoryMiB(prod.services[name]!.deploy!.resources!.limits!.memory!);
    expect(limit('evolution')).toBe(3072);
    expect(limit('postgres')).toBe(2048);
    expect(limit('redis')).toBe(512);
    expect(limit('api')).toBe(512);
    expect(limit('worker')).toBe(1024);
  });

  it('keeps the CX22 profile below 4 GB in total', () => {
    const total = Object.entries(prod.services).reduce((sum, [name, service]) => {
      const override = cx22.services[name]?.deploy?.resources?.limits?.memory;
      return sum + memoryMiB(override ?? service.deploy!.resources!.limits!.memory!);
    }, 0);
    expect(total).toBeLessThan(4096);
  });

  it('stops each process later than its shutdown budget (ARCH-11)', () => {
    const api = readEnvFile(readRepoFile('infra/env/api.env.example'));
    const seconds = (value: string | undefined) => Number(/^(\d+)s$/.exec(value ?? '')?.[1]);
    const budget = (name: string) => Number(api.get(name)) / 1000;
    // The worker refuses to start when its budget is shorter than the longest job plus 5 s.
    expect(budget('WORKER_SHUTDOWN_TIMEOUT_MS')).toBeGreaterThanOrEqual(100);
    expect(seconds(prod.services.worker!.stop_grace_period)).toBeGreaterThanOrEqual(
      budget('WORKER_SHUTDOWN_TIMEOUT_MS') + 5,
    );
    expect(seconds(prod.services.api!.stop_grace_period)).toBeGreaterThanOrEqual(
      budget('SHUTDOWN_TIMEOUT_MS') + 5,
    );
  });

  it('starts api and worker only after a successful migration', () => {
    for (const name of ['api', 'worker']) {
      expect(prod.services[name]!.depends_on?.migrate?.condition).toBe(
        'service_completed_successfully',
      );
    }
    expect(prod.services.migrate!.depends_on?.postgres?.condition).toBe('service_healthy');
  });

  it('isolates the data services on the internal network without internet access', () => {
    expect(prod.networks?.internal?.internal).toBe(true);
    expect(networkNames(prod.services.postgres!)).toEqual(['internal']);
    expect(networkNames(prod.services.caddy!)).toEqual(['edge']);
    expect(networkNames(prod.services.evolution!)).not.toContain('edge');
  });

  describe('metrics network (SEC-01)', () => {
    it('is internal and holds only the API, the workers, Alloy, and Redis', () => {
      expect(prod.networks?.metrics?.internal).toBe(true);
      const members = services
        .filter(([, service]) => networkNames(service).includes('metrics'))
        .map(([name]) => name)
        .sort();
      expect(members.filter((name) => name !== 'redis')).toEqual(['alloy', 'api', 'worker']);
      expect(networkNames(prod.services.evolution!)).not.toContain('metrics');
    });

    it('binds the metrics listeners of the API and the worker to their metrics address only', () => {
      const api = prod.services.api!.environment!;
      const worker = prod.services.worker!.environment!;
      expect(api['API_METRICS_HOST']).toBe(addressOn('api', 'metrics'));
      expect(api['API_METRICS_PORT']).toBe('9465');
      expect(worker['WORKER_METRICS_HOST']).toBe(addressOn('worker', 'metrics'));
      expect(worker['WORKER_METRICS_PORT']).toBe('9464');
      expect(JSON.stringify(prod.services.worker!.healthcheck!.test)).toContain(
        `http://${addressOn('worker', 'metrics')}:9464/health/live`,
      );
    });

    it('moves Alloy off the internal network and scrapes the metrics ports', () => {
      expect(networkNames(prod.services.alloy!).sort()).toEqual(['egress', 'metrics']);
      const alloy = readRepoFile('infra/observability/alloy/config.alloy');
      expect(alloy).toContain('"__address__" = "api:9465"');
      expect(alloy).toContain('"__address__" = "worker:9464"');
    });
  });

  describe('fixed addresses for the Evolution egress rules (SEC-01)', () => {
    it('gives each network of the rules a fixed subnet and a dynamic range above the fixed addresses', () => {
      for (const name of ['internal', 'egress', 'metrics']) {
        const config = prod.networks?.[name]?.ipam?.config?.[0];
        expect(config?.subnet, name).toMatch(/^10\.203\.\d+\.0\/24$/);
        expect(config?.ip_range, name).toBe(config!.subnet.replace(/0\/24$/, '128/25'));
      }
    });

    it('matches the addresses of firewall.env.example', () => {
      const firewall = readEnvFile(readRepoFile('infra/env/firewall.env.example'));
      expect(firewall.get('EVOLUTION_SOURCE_IPS')!.split(',')).toEqual([
        addressOn('evolution', 'internal'),
        addressOn('evolution', 'egress'),
      ]);
      expect(firewall.get('EVOLUTION_ALLOWED_DESTINATIONS')!.split(',')).toEqual([
        `${addressOn('postgres', 'internal')}:5432`,
        `${addressOn('redis', 'internal')}:6379`,
        `${addressOn('api', 'internal')}:3000`,
      ]);
      expect(prod.services.evolution!.environment ?? {}).not.toHaveProperty('WEBHOOK_GLOBAL_URL');
      expect(readRepoFile('infra/env/api.env.example')).toContain(
        'INTERNAL_WEBHOOK_BASE_URL=http://api:3000',
      );
    });
  });

  it('runs Redis with AOF everysec, noeviction, and a password', () => {
    const command = JSON.stringify(prod.services.redis!.command);
    expect(command).toContain('--appendonly yes');
    expect(command).toContain('--appendfsync everysec');
    expect(command).toContain('--maxmemory-policy noeviction');
    expect(command).toContain('--requirepass');
  });

  it('gives Evolution and Bot Center separate Redis users (SEC-11)', () => {
    const command = JSON.stringify(prod.services.redis!.command);
    expect(command).toContain(
      "--user botcenter on \\\">$$REDIS_BOTCENTER_PASSWORD\\\" '~bc:*' '~bull:*'",
    );
    expect(command).toContain(
      "--user evolution on \\\">$$REDIS_EVOLUTION_PASSWORD\\\" '~evolution:*' resetchannels '-@all'",
    );
    expect(command).toContain(
      '--user metrics on \\">$$REDIS_METRICS_PASSWORD\\" resetchannels \'-@all\'',
    );
    expect(JSON.stringify(cx22.services.redis ?? {})).not.toContain('command');
  });
});

describe('compose.dev.yml', () => {
  it('binds every port to 127.0.0.1', () => {
    for (const [name, service] of Object.entries(dev.services)) {
      for (const port of service.ports ?? []) {
        expect(port, name).toMatch(/^127\.0\.0\.1:/);
      }
    }
  });

  it('uses the same Evolution image as production', () => {
    expect(dev.services.evolution!.image).toBe(prod.services.evolution!.image);
  });
});

describe('evolution.flags.env', () => {
  const flags = readEnvFile(readRepoFile('infra/compose/evolution.flags.env'));

  it('keeps only the instances (sessions) and the new messages in the Evolution database', () => {
    const saveFlags = [...flags].filter(([name]) => name.startsWith('DATABASE_SAVE_'));
    const enabled = saveFlags.filter(([, value]) => value === 'true').map(([name]) => name);
    expect(enabled.sort()).toEqual([
      'DATABASE_SAVE_DATA_INSTANCE',
      'DATABASE_SAVE_DATA_NEW_MESSAGE',
    ]);
  });

  it('turns off telemetry, the global webhook, the manager, and the key in fetchInstances', () => {
    expect(flags.get('TELEMETRY_ENABLED')).toBe('false');
    expect(flags.get('WEBHOOK_GLOBAL_ENABLED')).toBe('false');
    expect(flags.get('SERVER_DISABLE_MANAGER')).toBe('true');
    expect(flags.get('AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES')).toBe('false');
    expect(flags.get('CACHE_REDIS_SAVE_INSTANCES')).toBe('false');
    expect(flags.get('DEL_INSTANCE')).toBe('false');
    expect(flags.get('TZ')).toBe('UTC');
  });

  it('writes no message content to the log (no WEBHOOKS or VERBOSE level)', () => {
    expect(flags.get('LOG_LEVEL')?.split(',')).not.toContain('WEBHOOKS');
    expect(flags.get('LOG_LEVEL')?.split(',')).not.toContain('VERBOSE');
  });

  it('has no secret', () => {
    for (const name of ['AUTHENTICATION_API_KEY', 'DATABASE_CONNECTION_URI', 'CACHE_REDIS_URI']) {
      expect(flags.has(name), name).toBe(false);
    }
  });
});
