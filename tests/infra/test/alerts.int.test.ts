import { describe, expect, it } from 'vitest';
import { ciImage } from './helpers/images.js';
import { repoPath, run } from './helpers/repo.js';

/** promtool of the CI image, with infra/observability/prometheus mounted read-only at /r. */
function promtool(...args: string[]) {
  return run('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${repoPath('infra/observability/prometheus')}:/r:ro`,
    '-w',
    '/r',
    '--entrypoint',
    'promtool',
    ciImage('PROMETHEUS_IMAGE'),
    ...args,
  ]);
}

describe('infra/observability/prometheus', () => {
  it('has valid alert rules', async () => {
    const result = await promtool('check', 'rules', 'alerts.yml');
    expect(result.code, result.stdout + result.stderr).toBe(0);
  });

  it('passes the unit tests of the alert rules (alerts.test.yml)', async () => {
    const result = await promtool('test', 'rules', 'alerts.test.yml');
    expect(result.code, result.stdout + result.stderr).toBe(0);
  });
});
