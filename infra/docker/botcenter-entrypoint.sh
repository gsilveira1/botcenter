#!/bin/sh
# Entrypoint of the Bot Center image. tini starts it as PID 1's child and forwards the signals.
#   With arguments: runs them (for example `pnpm --filter @botcenter/api db:migrate`).
#   Without arguments: ROLE=api starts dist/main.js, ROLE=worker starts dist/worker.js.
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

case "${ROLE:-}" in
  api) exec node dist/main.js ;;
  worker) exec node dist/worker.js ;;
  *)
    echo "botcenter-entrypoint: ROLE must be 'api' or 'worker' (value: '${ROLE:-}')" >&2
    exit 64
    ;;
esac
