#!/usr/bin/env node
// Starts the fake Evolution server of @botcenter/whatsapp-provider for the load test.
// Contract (the provider package owns the server: src/testing/fake-evolution-cli.ts):
//   FAKE_EVOLUTION_API_KEY     required; the API uses the same value as EVOLUTION_API_KEY
//   FAKE_EVOLUTION_PORT        default 8080 (the API uses EVOLUTION_URL=http://localhost:<port>)
//   FAKE_EVOLUTION_HOST        default 0.0.0.0
//   FAKE_EVOLUTION_AUTO_STATUS sent, delivered, or read: the server sends messages.update webhooks
// Build the provider first: pnpm --filter @botcenter/whatsapp-provider build
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(
  new URL('../../packages/whatsapp-provider/dist/testing/fake-evolution-cli.js', import.meta.url),
);
if (!existsSync(cli)) {
  console.error(
    `fake-evolution: ${cli} does not exist. Run: pnpm --filter @botcenter/whatsapp-provider build`,
  );
  process.exit(1);
}
if (!process.env.FAKE_EVOLUTION_API_KEY) {
  console.error('fake-evolution: FAKE_EVOLUTION_API_KEY is required');
  process.exit(1);
}

const child = spawn(process.execPath, [cli], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`fake-evolution: the server stopped with ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
