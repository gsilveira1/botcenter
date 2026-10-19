# Load tests (`@botcenter/tests-load`)

k6 scenarios for the Bot Center API. The architecture asks for a load test before production: the p95 latency of the API, the throughput of the workers, and the memory for each connected instance.

| Scenario            | Request                 | Thresholds                                            |
| ------------------- | ----------------------- | ----------------------------------------------------- |
| `send-messages.js`  | `POST /v1/messages`     | p95 below 150 ms for the 202 answer, errors below 1 % |
| `message-status.js` | `GET /v1/messages/{id}` | p95 below 100 ms, errors below 1 %                    |

Each scenario uses a constant arrival rate. k6 starts `RATE` requests each second, so a slow API shows as a higher latency, not as a lower request rate. k6 runs in the `grafana/k6` container (`run-k6.sh`). You do not install k6.

`pnpm test` checks the options and the payloads (`lib/config.js`) with `node --test`. It does not start k6.

## Variables

| Variable         | Default                            | Use                                                        |
| ---------------- | ---------------------------------- | ---------------------------------------------------------- |
| `BASE_URL`       | `http://host.docker.internal:3000` | The API. The k6 container reaches the host with this name. |
| `API_KEY`        | (required)                         | A key with the scope `messages:send`.                      |
| `INSTANCE_ID`    | (required)                         | A connected instance of the tenant of the key.             |
| `TO`             | `5511999990000`                    | The recipient. The fake server accepts any number.         |
| `RATE`           | `50`                               | Requests per second.                                       |
| `DURATION`       | `2m`                               | The duration of the run.                                   |
| `VUS`, `MAX_VUS` | `max(10, RATE/5)`, `4 × VUS`       | Pre-allocated and maximum virtual users.                   |
| `SEED_MESSAGES`  | `50`                               | `message-status.js`: messages that `setup()` creates.      |

`run-k6.sh` writes the summary to `results/<scenario>-<time>.json` (git ignores `results/`).

## Run against the local stack with the fake Evolution server

The fake server replaces the Evolution API, so the test measures the Bot Center only. No real WhatsApp number is necessary.

1. Start PostgreSQL, Redis, and MinIO:

   ```sh
   docker compose -f infra/compose/compose.dev.yml up -d postgres redis minio minio-init
   ```

2. Build the workspace and apply the migrations:

   ```sh
   pnpm install && pnpm build
   DATABASE_URL_MIGRATE=postgresql://botcenter_owner:change-me@localhost:5432/botcenter pnpm db:migrate
   ```

3. Start the fake Evolution server on port 8081 (the dev Evolution container uses 8080). It sends `messages.update` webhooks with the status `delivered`:

   ```sh
   FAKE_EVOLUTION_API_KEY=fake-key FAKE_EVOLUTION_PORT=8081 FAKE_EVOLUTION_AUTO_STATUS=delivered \
     pnpm --filter @botcenter/tests-load fake-evolution
   ```

   Contract of `fake-evolution.mjs`: it runs `packages/whatsapp-provider/dist/testing/fake-evolution-cli.js` with the same environment (`FAKE_EVOLUTION_API_KEY` required, `FAKE_EVOLUTION_PORT` default 8080, `FAKE_EVOLUTION_HOST` default `0.0.0.0`, `FAKE_EVOLUTION_AUTO_STATUS` = `sent`, `delivered`, or `read`). It stops with exit code 1 when the provider package is not built.

4. Start the API and the workers with `EVOLUTION_URL=http://localhost:8081`, `EVOLUTION_API_KEY=fake-key`, and `INTERNAL_WEBHOOK_BASE_URL=http://localhost:3000` (the fake server runs on the host). Use two terminals:

   ```sh
   ROLE=api pnpm --filter @botcenter/api start
   ROLE=worker pnpm --filter @botcenter/api start:worker
   ```

5. Make a tenant, a key, and an instance:

   ```sh
   pnpm --filter @botcenter/api admin:tenant:create --name LoadTest --slug loadtest
   pnpm --filter @botcenter/api admin:key:create --tenant loadtest --name k6 --scopes messages:send,instances:manage
   ```

   Then create an instance with `POST /v1/instances` and connect it with `POST /v1/instances/{id}/connect`. The fake server marks it connected.

6. Run the scenarios:

   ```sh
   cd tests/load
   API_KEY=bc_live_... INSTANCE_ID=<uuid> RATE=50 DURATION=2m ./run-k6.sh send-messages.js
   API_KEY=bc_live_... INSTANCE_ID=<uuid> RATE=100 ./run-k6.sh message-status.js
   ```

   k6 exits with a code that is not 0 when a threshold fails.

7. Read the worker throughput in the metrics of the worker (`http://localhost:9464/metrics`): `botcenter_messages_total{status="sent"}` and `botcenter_queue_delay_seconds{queue="outbound"}`. The outbound delay must stay below 30 s.

Note: the rate limit of the instance (`rateLimitPerMinute`) and the daily quota of the tenant also apply in a load test. Increase them for the test tenant with `admin:tenant:update-quotas`, or the API answers 429.

## Measure the memory for each connected instance

The memory of the Evolution API for each connected number decides how many numbers fit on one host (architecture, section "Baixo custo"). The fake server cannot measure it, because it has no Baileys session. Use a test host and real test numbers.

1. Deploy the production stack on a test host (`docs/runbook.md`, procedure "Update the Evolution API" uses the same test host).
2. Record the base value with no instance:

   ```sh
   EVOLUTION_API_KEY=<key> tests/load/measure-evolution-memory.sh 60 10 > base.csv
   ```

3. Connect the test numbers one at a time (QR code or pairing code). Wait 10 minutes after each connection (the first history sync uses more memory).
4. Sample again for 30 minutes with traffic from `send-messages.js` at the expected rate:

   ```sh
   EVOLUTION_API_KEY=<key> tests/load/measure-evolution-memory.sh 60 30 > connected.csv
   ```

5. Calculate `(memory with N connected − base memory) / N`. Record the value and the number of numbers per host in `docs/implementation-plan.md`, section 8. Then set the memory limit of Evolution in `compose.prod.yml` (`EVOLUTION_MEMORY`).
