// Commands in the containers of the smoke stack (`docker compose exec`).
import { execFileSync } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** @param {string[]} composeArgs The `-p`, `-f`, and `--env-file` arguments of the stack. */
export function createStack(composeArgs) {
  /**
   * @param {string[]} args
   * @param {string} [input]
   */
  const compose = (args, input) =>
    execFileSync('docker', ['compose', ...composeArgs, ...args], {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });

  return {
    /**
     * Runs the admin CLI in the `api` container. Returns the JSON of stdout.
     * @param {string[]} args
     */
    admin: (args) =>
      JSON.parse(
        compose([
          'exec',
          '-T',
          'api',
          'node',
          'dist/scripts/admin.js',
          ...args,
          '--actor',
          'smoke',
        ]),
      ),
    /**
     * Runs SQL as the superuser in the `botcenter` database. Returns the rows as JSON objects.
     * @param {string} sql A query that returns rows, or a statement.
     */
    sql: (sql) => {
      const out = compose(
        [
          'exec',
          '-T',
          'postgres',
          'psql',
          '-U',
          'postgres',
          '-d',
          'botcenter',
          '-v',
          'ON_ERROR_STOP=1',
          '-tA',
        ],
        `SELECT coalesce(json_agg(t), '[]') FROM (${sql}) t;`,
      );
      return JSON.parse(out.trim());
    },
    /** @param {string} sql */
    exec: (sql) =>
      compose(
        [
          'exec',
          '-T',
          'postgres',
          'psql',
          '-U',
          'postgres',
          '-d',
          'botcenter',
          '-v',
          'ON_ERROR_STOP=1',
          '-q',
        ],
        sql,
      ),
    /** The Prometheus text of the worker (internal listener on its `metrics` address, port 9464). */
    workerMetrics: () =>
      compose([
        'exec',
        '-T',
        'worker',
        'sh',
        '-c',
        'wget -q -O - "http://$WORKER_METRICS_HOST:9464/metrics"',
      ]),
    /**
     * The log lines of a service since the start of the stack.
     * @param {string} service
     */
    logs: (service) => compose(['logs', '--no-color', '--no-log-prefix', service]),
  };
}

/**
 * Reads one value of an env file of the stack (for example DATA_ENCRYPTION_KEY of api.env).
 * @param {string} file
 * @param {string} name
 */
export function readEnvValue(file, name) {
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((item) => item.startsWith(`${name}=`));
  if (line === undefined) throw new Error(`${file} has no ${name}`);
  return line.slice(name.length + 1);
}

/**
 * The `SecretBox` format of the API (`v1.<iv>.<tag>.<ciphertext>`, AES-256-GCM, base64url parts).
 * The smoke test uses it to write a subscription row directly (the documented workaround).
 * @param {string} keyBase64
 * @param {string} plaintext
 * @param {string} aad
 */
export function sealSecret(keyBase64, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}
