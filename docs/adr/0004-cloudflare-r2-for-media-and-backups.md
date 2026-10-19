# 0004. Cloudflare R2 for media and backups

- Status: Accepted (2026-10-18)
- Source: architecture, sections "Componentes e tecnologias", "Baixo custo", and "Observabilidade, backup e operação"

## Context

The bots send and receive media files. The backups must leave the host, encrypted. The egress fees of S3 storage can cost more than the server.

## Decision

Use Cloudflare R2 (S3 API) for two private buckets: `botcenter-media` (media, pre-signed URLs with a short validity) and `botcenter-backups` (restic repository). Each bucket has its own API token. Local runs and tests use MinIO.

## Consequences

- No egress fees, and the first 10 GB are free.
- restic encrypts the backups on the host before the upload. The restic password is the only key: the team keeps a copy in its password manager.
- The code uses the S3 API only, so a move to an other provider changes only the configuration.
