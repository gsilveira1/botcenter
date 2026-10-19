import { parseArgs } from 'node:util';
import { AppError } from '../common/errors/app-error';
import type { AdminService, TenantQuotas } from '../admin/admin.service';

/**
 * The admin commands (plan, section 8). `admin.ts` runs them from `dist`; the tests call `runAdminCli`.
 * The output is one JSON document on stdout. An error goes to stderr with exit code 1.
 */
export const ADMIN_USAGE = `Usage: node dist/scripts/admin.js <command> [options]

Commands:
  tenant:create        --name <text> --slug <slug> [quota options]
  tenant:update-quotas --tenant <id|slug> [quota options]
  key:create           --tenant <id|slug> --name <text> --scopes <a,b> [--instances <id,id>]
                       [--allowed-ips <ip,cidr>] [--rate-limit-per-minute <n>] [--expires-at <ISO date>]
  key:list             --tenant <id|slug>
  key:revoke           --key <prefix|id>
  key:rotate           --key <prefix|id> [--name <text>]

Quota options: --max-instances <n> --max-messages-per-day <n> --retention-days <n>
               --rate-limit-per-minute <n> --instance-rate-limit-per-minute <n>
Common option: --actor <name> (audit actor; default: $BOTCENTER_OPERATOR or $USER)`;

const OPTIONS = {
  name: { type: 'string' },
  slug: { type: 'string' },
  tenant: { type: 'string' },
  key: { type: 'string' },
  scopes: { type: 'string' },
  instances: { type: 'string' },
  'allowed-ips': { type: 'string' },
  'expires-at': { type: 'string' },
  'max-instances': { type: 'string' },
  'max-messages-per-day': { type: 'string' },
  'retention-days': { type: 'string' },
  'rate-limit-per-minute': { type: 'string' },
  'instance-rate-limit-per-minute': { type: 'string' },
  actor: { type: 'string' },
  help: { type: 'boolean' },
} as const;

type Values = Partial<Record<keyof typeof OPTIONS, string | boolean>>;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

class UsageError extends Error {}

function text(values: Values, name: keyof typeof OPTIONS, required = false): string | undefined {
  const value = values[name];
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  if (required) {
    throw new UsageError(`Missing option --${name}`);
  }
  return undefined;
}

function integer(values: Values, name: keyof typeof OPTIONS): number | undefined {
  const value = text(values, name);
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`--${name} must be a positive integer`);
  }
  return Number(value);
}

function list(values: Values, name: keyof typeof OPTIONS): string[] | undefined {
  const value = text(values, name);
  return value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function quotas(values: Values): TenantQuotas {
  return {
    maxInstances: integer(values, 'max-instances'),
    maxMessagesPerDay: integer(values, 'max-messages-per-day'),
    retentionDays: integer(values, 'retention-days'),
    rateLimitPerMinute: integer(values, 'rate-limit-per-minute'),
    instanceRateLimitPerMinute: integer(values, 'instance-rate-limit-per-minute'),
  };
}

function date(values: Values, name: keyof typeof OPTIONS): Date | undefined {
  const value = text(values, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageError(`--${name} must be an ISO 8601 date`);
  }
  return parsed;
}

async function execute(
  command: string,
  values: Values,
  admin: AdminService,
  actor: string,
): Promise<unknown> {
  switch (command) {
    case 'tenant:create':
      return admin.createTenant(
        { name: text(values, 'name', true)!, slug: text(values, 'slug', true)!, ...quotas(values) },
        actor,
      );
    case 'tenant:update-quotas':
      return admin.updateQuotas(text(values, 'tenant', true)!, quotas(values), actor);
    case 'key:create': {
      const created = await admin.createKey(
        {
          tenant: text(values, 'tenant', true)!,
          name: text(values, 'name', true)!,
          scopes: list(values, 'scopes') ?? [],
          instanceIds: list(values, 'instances'),
          allowedIps: list(values, 'allowed-ips'),
          rateLimitPerMinute: integer(values, 'rate-limit-per-minute'),
          expiresAt: date(values, 'expires-at'),
        },
        actor,
      );
      return {
        key: created.key,
        api_key: created.apiKey,
        notice: 'Store the key now. It is not shown again.',
      };
    }
    case 'key:list':
      return admin.listKeys(text(values, 'tenant', true)!, actor);
    case 'key:revoke':
      return admin.revokeKey(text(values, 'key', true)!, actor);
    case 'key:rotate': {
      const rotated = await admin.rotateKey(
        text(values, 'key', true)!,
        actor,
        text(values, 'name'),
      );
      return {
        key: rotated.key,
        api_key: rotated.apiKey,
        replaces: rotated.replaces,
        notice:
          'Store the key now. It is not shown again. Revoke the old key after the client changed it.',
      };
    }
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

/** Runs one admin command. Returns the exit code. */
export async function runAdminCli(argv: string[], admin: AdminService, io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${ADMIN_USAGE}`);
    return 2;
  }
  const [command] = parsed.positionals;
  if (!command || parsed.values.help) {
    io.err(ADMIN_USAGE);
    return command ? 0 : 2;
  }
  const env = io.env ?? process.env;
  const operator =
    text(parsed.values, 'actor') ?? env['BOTCENTER_OPERATOR'] ?? env['USER'] ?? 'operator';
  try {
    const result = await execute(command, parsed.values, admin, `cli:${operator}`);
    io.out(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${ADMIN_USAGE}`);
      return 2;
    }
    if (error instanceof AppError) {
      const fields = error.errors?.map((item) => `  ${item.path}: ${item.message}`).join('\n');
      io.err(`${error.code}: ${error.detail}${fields ? `\n${fields}` : ''}`);
      return 1;
    }
    throw error;
  }
}
