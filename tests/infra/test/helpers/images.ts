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
