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
  networks?: string[];
  command?: string[] | string;
  healthcheck?: { test?: unknown; disable?: boolean };
  depends_on?: Record<string, { condition: string }>;
  deploy?: { resources?: { limits?: { memory?: string } } };
  environment?: Record<string, string>;
}
interface ComposeFile {
  services: Record<string, Service>;
  networks?: Record<string, { internal?: boolean }>;
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
    expect(prod.services.postgres!.networks).toEqual(['internal']);
    expect(prod.services.redis!.networks).toEqual(['internal']);
    expect(prod.services.caddy!.networks).toEqual(['edge']);
    expect(prod.services.evolution!.networks).not.toContain('edge');
  });

  it('runs Redis with AOF everysec, noeviction, and a password', () => {
    const command = JSON.stringify(prod.services.redis!.command);
    expect(command).toContain('--appendonly yes');
    expect(command).toContain('--appendfsync everysec');
    expect(command).toContain('--maxmemory-policy noeviction');
    expect(command).toContain('--requirepass');
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
