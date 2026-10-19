import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRISMA_DIR, prisma } from './prisma-cli';

const MIGRATIONS_DIR = path.join(PRISMA_DIR, 'migrations');
const INIT = '20261019000000_init';

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('migrations directory', () => {
  it('names every migration <timestamp>_<slug> and gives it a migration.sql', () => {
    const names = migrationNames();
    expect(names[0]).toBe(INIT);
    for (const name of names) {
      expect(name).toMatch(/^\d{14}_[a-z0-9_-]+$/);
      expect(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8')).not.toBe('');
    }
  });

  it('makes audit_logs insert only in the first migration', () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, INIT, 'migration.sql'), 'utf8');
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON "audit_logs"/);
    expect(sql).toMatch(/BEFORE TRUNCATE ON "audit_logs"/);
  });

  it('starts the first migration with the SQL that Prisma generates from an empty database', async () => {
    // Prisma 7 needs a datasource URL for an offline diff. The config sets a placeholder URL.
    const result = await prisma([
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema',
      'schema.prisma',
      '--script',
    ]);
    expect(result.code).toBe(0);
    const generated = result.stdout.trim();
    expect(generated).toContain('CREATE TABLE "tenants"');
    const sql = readFileSync(path.join(MIGRATIONS_DIR, INIT, 'migration.sql'), 'utf8');
    if (migrationNames().length === 1) {
      expect(sql.startsWith(generated)).toBe(true);
    }
  });
});
