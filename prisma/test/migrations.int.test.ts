import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './prisma-cli';

let container: StartedPostgreSqlContainer;
let client: pg.Client;
let env: NodeJS.ProcessEnv;
let tenantId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  env = { DATABASE_URL_MIGRATE: container.getConnectionUri() };
  const deploy = await prisma(['migrate', 'deploy'], env);
  if (deploy.code !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${deploy.stdout}\n${deploy.stderr}`);
  }
  client = new pg.Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const tenant = await client.query<{ id: string }>(
    `INSERT INTO tenants (id, name, slug, "updatedAt") VALUES ($1, 'PersonalLife', 'personallife', now()) RETURNING id`,
    [randomUUID()],
  );
  tenantId = tenant.rows[0]!.id;
});

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

describe('first migration on PostgreSQL 16', () => {
  it('matches schema.prisma (no drift)', async () => {
    const diff = await prisma(
      [
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'schema.prisma',
        '--exit-code',
      ],
      env,
    );
    // Exit code 0: no difference. Exit code 2: the database and the schema differ.
    expect(diff.stdout + diff.stderr).not.toContain('[+]');
    expect(diff.code).toBe(0);
  });

  it('refuses UPDATE, DELETE, and TRUNCATE on audit_logs', async () => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO audit_logs (id, "tenantId", actor, action, "targetType") VALUES ($1, $2, 'cli:test', 'tenant.create', 'tenant') RETURNING id`,
      [randomUUID(), tenantId],
    );
    const id = inserted.rows[0]!.id;

    await expect(
      client.query(`UPDATE audit_logs SET action = 'changed' WHERE id = $1`, [id]),
    ).rejects.toThrow(/insert only: UPDATE/);
    await expect(client.query(`DELETE FROM audit_logs WHERE id = $1`, [id])).rejects.toThrow(
      /insert only: DELETE/,
    );
    await expect(client.query(`TRUNCATE audit_logs`)).rejects.toThrow(/insert only: TRUNCATE/);

    const count = await client.query(`SELECT count(*)::int AS n FROM audit_logs WHERE id = $1`, [
      id,
    ]);
    expect(count.rows[0].n).toBe(1);
  });

  it('allows one active instance for each external_ref', async () => {
    const insert = (deletedAt: string | null) =>
      client.query(
        `INSERT INTO instances (id, "tenantId", "externalRef", "providerName", "consentAt", "rateLimitPerMinute", "deletedAt", "updatedAt")
         VALUES ($1, $2, 'trainer-1', $3, now(), 20, $4, now())`,
        [randomUUID(), tenantId, `inst_${randomUUID()}`, deletedAt],
      );

    await insert(new Date().toISOString());
    await insert(null);
    await expect(insert(null)).rejects.toThrow(/instances_tenantId_externalRef_active_key/);
  });

  it('generates UUID v7 ids in the client, not in the database', async () => {
    const result = await client.query(
      `SELECT column_default FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'id'`,
    );
    expect(result.rows[0].column_default).toBeNull();
  });
});
