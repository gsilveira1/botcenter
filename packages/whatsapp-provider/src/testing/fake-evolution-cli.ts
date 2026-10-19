#!/usr/bin/env node
/**
 * Runs the fake Evolution server as a process, for Compose smoke tests and the k6 load test.
 * Environment: `FAKE_EVOLUTION_HOST` (default `0.0.0.0`), `FAKE_EVOLUTION_PORT` (default `8080`),
 * `FAKE_EVOLUTION_API_KEY` (required), `FAKE_EVOLUTION_AUTO_STATUS` (`sent`, `delivered`, or `read`).
 */
import { FakeEvolutionServer } from './fake-evolution-server.js';

const AUTO_STATUS = ['sent', 'delivered', 'read'] as const;

async function main(): Promise<void> {
  const apiKey = process.env.FAKE_EVOLUTION_API_KEY;
  if (!apiKey) throw new Error('FAKE_EVOLUTION_API_KEY is required');
  const port = Number(process.env.FAKE_EVOLUTION_PORT ?? '8080');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('FAKE_EVOLUTION_PORT must be a port number');
  }
  const autoStatus = process.env.FAKE_EVOLUTION_AUTO_STATUS;
  if (autoStatus && !AUTO_STATUS.includes(autoStatus as (typeof AUTO_STATUS)[number])) {
    throw new Error(`FAKE_EVOLUTION_AUTO_STATUS must be one of ${AUTO_STATUS.join(', ')}`);
  }

  const server = await FakeEvolutionServer.start({
    apiKey,
    host: process.env.FAKE_EVOLUTION_HOST ?? '0.0.0.0',
    port,
    maxRecordedCalls: 1_000,
    ...(autoStatus ? { autoStatus: autoStatus as (typeof AUTO_STATUS)[number] } : {}),
  });
  console.warn(JSON.stringify({ level: 'info', message: 'Fake Evolution server started', port }));

  const stop = (signal: string) => {
    console.warn(
      JSON.stringify({ level: 'info', message: 'Fake Evolution server stopping', signal }),
    );
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'Fake Evolution server stop failed',
            error: String(error),
          }),
        );
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'Fake Evolution server failed',
      error: String(error),
    }),
  );
  process.exit(1);
});
