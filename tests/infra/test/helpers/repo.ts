import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/** The repository root (tests/infra/test/helpers -> ../../../..). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function repoPath(...parts: string[]): string {
  return path.join(REPO_ROOT, ...parts);
}

export function readRepoFile(...parts: string[]): string {
  return readFileSync(repoPath(...parts), 'utf8');
}

/** Parses a YAML file of the repository. `merge` resolves the `<<: *anchor` keys of Compose. */
export function readYaml<T>(...parts: string[]): T {
  return parse(readRepoFile(...parts), { merge: true }) as T;
}

/** Parses a dotenv file: `NAME=value` lines, no comments. */
export function readEnvFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1]!, match[2]!);
  }
  return values;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command and collects its output. It never throws for a non-zero exit code. */
export function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd: string = REPO_ROOT,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export interface CapturedRequest {
  url: string;
  body: string;
}

/** A local HTTP server that records each request (a fake Discord webhook or Uptime Kuma). */
export async function startRecorder(): Promise<{
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
