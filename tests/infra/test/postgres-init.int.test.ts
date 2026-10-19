import { readdirSync } from 'node:fs';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prodImage } from './helpers/images.js';
import { readRepoFile, repoPath } from './helpers/repo.js';

const PASSWORDS = {
  POSTGRES_PASSWORD: 'superuser-password',
  BOTCENTER_OWNER_PASSWORD: 'owner-password',
  BOTCENTER_APP_PASSWORD: 'app-password',
  EVOLUTION_DB_PASSWORD: 'evolution-password',
};

let container: StartedTestContainer;

function client(user: string, password: string, database: string): pg.Client {
  return new pg.Client({
    host: container.getHost(),
    port: container.getMappedPort(5432),
    user,
    password,
    database,
  });
}

async function query(user: string, password: string, database: string, sql: string) {
  const c = client(user, password, database);
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  // The same image and user as compose.prod.yml.
  container = await new GenericContainer(prodImage('postgres'))
    .withUser('70:70')
    .withTmpFs({ '/var/run/postgresql': 'rw,mode=1777', '/tmp': 'rw,mode=1777' })
    .withEnvironment(PASSWORDS)
    .withCopyDirectoriesToContainer([
      { source: repoPath('infra/postgres/init'), target: '/docker-entrypoint-initdb.d' },
    ])
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  // The owner role applies the real migrations (as `prisma migrate deploy` does).
  const migrations = readdirSync(repoPath('prisma/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const owner = client('botcenter_owner', PASSWORDS.BOTCENTER_OWNER_PASSWORD, 'botcenter');
  await owner.connect();
  try {
    for (const name of migrations) {
      await owner.query(readRepoFile('prisma/migrations', name, 'migration.sql'));
    }
  } finally {
    await owner.end();
  }
});

afterAll(async () => {
  await container?.stop();
});

describe('infra/postgres/init/01-databases.sh', () => {
  it('makes botcenter_owner the owner of every table of the migrations', async () => {
    const result = await query(
      'postgres',
      PASSWORDS.POSTGRES_PASSWORD,
      'botcenter',
      `SELECT count(*)::int AS tables, count(*) FILTER (WHERE tableowner <> 'botcenter_owner')::int AS others
       FROM pg_tables WHERE schemaname = 'public'`,
    );
    expect(result.rows[0].tables).toBeGreaterThanOrEqual(15);
    expect(result.rows[0].others).toBe(0);
  });

  it('lets botcenter_app read and write rows of the migrated tables', async () => {
    await query(
      'botcenter_app',
      PASSWORDS.BOTCENTER_APP_PASSWORD,
      'botcenter',
      `INSERT INTO tenants (id, name, slug, "updatedAt") VALUES (gen_random_uuid(), 'Test', 'test', now())`,
    );
    const result = await query(
      'botcenter_app',
      PASSWORDS.BOTCENTER_APP_PASSWORD,
      'botcenter',
      'SELECT count(*)::int AS n FROM tenants',
    );
    expect(result.rows[0].n).toBe(1);
  });

  it('refuses DDL to botcenter_app', async () => {
    await expect(
      query(
        'botcenter_app',
        PASSWORDS.BOTCENTER_APP_PASSWORD,
        'botcenter',
        'CREATE TABLE x (id int)',
      ),
    ).rejects.toThrow(/permission denied for schema public/);
    await expect(
      query('botcenter_app', PASSWORDS.BOTCENTER_APP_PASSWORD, 'botcenter', 'DROP TABLE tenants'),
    ).rejects.toThrow(/must be owner/);
  });

  it('keeps the audit log insert only, also for botcenter_app', async () => {
    await query(
      'botcenter_app',
      PASSWORDS.BOTCENTER_APP_PASSWORD,
      'botcenter',
      `INSERT INTO audit_logs (id, "tenantId", actor, action, "targetType")
       SELECT gen_random_uuid(), id, 'cli:test', 'tenant.create', 'tenant' FROM tenants LIMIT 1`,
    );
    await expect(
      query(
        'botcenter_app',
        PASSWORDS.BOTCENTER_APP_PASSWORD,
        'botcenter',
        'DELETE FROM audit_logs',
      ),
    ).rejects.toThrow(/insert only/);
    await expect(
      query(
        'botcenter_app',
        PASSWORDS.BOTCENTER_APP_PASSWORD,
        'botcenter',
        `UPDATE audit_logs SET action = 'x'`,
      ),
    ).rejects.toThrow(/insert only/);
  });

  it('refuses a connection to the database of the other application', async () => {
    await expect(
      query('botcenter_app', PASSWORDS.BOTCENTER_APP_PASSWORD, 'evolution', 'SELECT 1'),
    ).rejects.toThrow(/permission denied for database "evolution"/);
    await expect(
      query('evolution', PASSWORDS.EVOLUTION_DB_PASSWORD, 'botcenter', 'SELECT 1'),
    ).rejects.toThrow(/permission denied for database "botcenter"/);
  });

  it('lets the evolution role create its own schema objects', async () => {
    await query(
      'evolution',
      PASSWORDS.EVOLUTION_DB_PASSWORD,
      'evolution',
      'CREATE TABLE "Instance" (id text PRIMARY KEY)',
    );
    const result = await query(
      'evolution',
      PASSWORDS.EVOLUTION_DB_PASSWORD,
      'evolution',
      `SELECT tableowner FROM pg_tables WHERE tablename = 'Instance'`,
    );
    expect(result.rows[0].tableowner).toBe('evolution');
  });
});
