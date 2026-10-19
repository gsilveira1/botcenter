import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const PRISMA_DIR = path.resolve(__dirname, '..');
const PRISMA_BIN = path.join(PRISMA_DIR, 'node_modules', '.bin', 'prisma');

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the Prisma CLI of this package with `prisma.config.ts`. A non-zero exit code is a result, not an error. */
export async function prisma(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(PRISMA_BIN, [...args, '--config', 'prisma.config.ts'], {
      cwd: PRISMA_DIR,
      env: { ...process.env, ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof failure.code !== 'number') {
      throw error;
    }
    return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}
