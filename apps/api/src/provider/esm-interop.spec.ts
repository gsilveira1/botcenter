import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = path.resolve(__dirname, '..', '..');

/**
 * The Nest build is CommonJS and `@botcenter/whatsapp-provider` is ESM. `dist/main.js` loads the package
 * with `require(esm)` (Node 24). A top-level `await` in the package stops `require(esm)`, so this test
 * loads the built package from a CommonJS process, as `dist/main.js` does.
 */
describe('@botcenter/whatsapp-provider in the CommonJS build', () => {
  it('loads with require() and gives the Evolution adapter and the normalizer', () => {
    const script = [
      "const provider = require('@botcenter/whatsapp-provider');",
      'const names = ["EvolutionProvider", "EvolutionWebhookNormalizer", "ProviderError"];',
      'process.stdout.write(names.map((name) => typeof provider[name]).join(","));',
    ].join('\n');

    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: API_ROOT,
      encoding: 'utf8',
    });

    expect(output).toBe('function,function,function');
  });
});
