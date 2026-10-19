import { readFileSync } from 'node:fs';

/**
 * Loads the Evolution API 2.3.7 fixtures (`fixtures/evolution-2.3.7`). Tests only.
 * See the "Fixtures" section of the README for the source of each file.
 */
const ROOT = new URL('../../fixtures/evolution-2.3.7/', import.meta.url);

export interface ApiFixture {
  status: number;
  body: unknown;
}

export function webhookFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`webhooks/${name}.json`, ROOT), 'utf8')) as Record<
    string,
    unknown
  >;
}

export function apiFixture(name: string): ApiFixture {
  return JSON.parse(readFileSync(new URL(`api/${name}.json`, ROOT), 'utf8')) as ApiFixture;
}
