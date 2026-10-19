import { readRepoFile } from './repo.js';

/** The image of a service in compose.prod.yml, so the tests use the production versions. */
export function prodImage(service: string): string {
  const compose = readRepoFile('infra/compose/compose.prod.yml');
  const block = compose
    .split(/\n {2}(?=[a-z-]+:\n)/)
    .find((part) => part.startsWith(`${service}:`));
  const match = block && /\n\s+image: (\S+)/.exec(block);
  if (!match) throw new Error(`no image for the service ${service} in compose.prod.yml`);
  return match[1]!;
}

/** Node for the fake upstream of the Caddy test (the base image of infra/docker/api.Dockerfile). */
export function nodeImage(): string {
  const match = /^ARG NODE_IMAGE=(\S+)$/m.exec(readRepoFile('infra/docker/api.Dockerfile'));
  if (!match) throw new Error('no NODE_IMAGE in api.Dockerfile');
  return match[1]!;
}

/** A tool image that the CI workflow pins (`<NAME>: image@sha256:...` in .github/workflows/ci.yml). */
export function ciImage(name: string): string {
  const match = new RegExp(`^\\s+${name}: (\\S+@sha256:[0-9a-f]{64})$`, 'm').exec(
    readRepoFile('.github/workflows/ci.yml'),
  );
  if (!match) throw new Error(`no ${name} in .github/workflows/ci.yml`);
  return match[1]!;
}
