# Load test results

## 2026-10-19: release candidate v0.1.0 (`develop` at `3bcaffa`)

### Setup

| Item           | Value                                                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine        | Intel Core 7 240H (16 logical CPUs), 22 GB RAM, WSL2 (kernel 6.6.87.2), Docker 29.1.3. Other development stacks ran on the same machine.                                                                                                                       |
| Versions       | Node 24.14.0 on the host, k6 1.8.2 (`grafana/k6` container), PostgreSQL 16.15 and Redis 7.4.11 (`infra/compose/compose.dev.yml`, default settings)                                                                                                             |
| API and worker | `node dist/main.js` and `node dist/worker.js` on the host, `NODE_ENV=production`, `LOG_LEVEL=info` (logs to a file), `NODE_OPTIONS=--max-old-space-size=384` (API) and `768` (worker), `DATABASE_POOL_SIZE=10`, `WORKER_CONCURRENCY_OUTBOUND=10` (the default) |
| Provider       | `FakeEvolutionServer` (`pnpm fake-evolution`), `FAKE_EVOLUTION_AUTO_STATUS=delivered`: each send gets a `messages.update` webhook with `delivered`                                                                                                             |
| Tenant         | 20 connected instances, `rate_limit_per_minute=600` each (200 sends per second in total), `OUTBOUND_WARMUP_DAYS=0`, high key and daily limits                                                                                                                  |
| Scenarios      | `send-messages.js` with `INSTANCE_IDS` (the 20 instances in rotation), `message-status.js`                                                                                                                                                                     |

### Numbers

| Run                                    | Requests                              | p95 (median, p99)      | Errors | Thresholds                                   |
| -------------------------------------- | ------------------------------------- | ---------------------- | ------ | -------------------------------------------- |
| `send-messages.js`, `RATE=50`, 2 min   | 5987 × `POST /v1/messages` (202)      | 128 ms (20 ms, 269 ms) | 0 %    | pass (p95 < 150 ms, errors < 1 %)            |
| `send-messages.js`, `RATE=150`, 1 min  | 8941 × `POST /v1/messages` (202)      | 209 ms (39 ms, 555 ms) | 0 %    | p95 fails (stress run above the target rate) |
| `message-status.js`, `RATE=100`, 2 min | 12051 × `GET /v1/messages/{id}` (200) | 13 ms (4 ms, 17 ms)    | 0 %    | pass (p95 < 100 ms, errors < 1 %)            |

| Worker and queue                                                                                           | `RATE=50` | `RATE=150` |
| ---------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| Messages `sent` per second (average of the run)                                                            | 47.1      | 137.6      |
| Messages `sent` per second (best 10 s window)                                                              | 53.9      | 156.7      |
| Outbound queue delay (`botcenter_queue_delay_seconds{queue="outbound"}`, maximum of the samples every 2 s) | 0.012 s   | 0.046 s    |
| Waiting outbound jobs (maximum)                                                                            | 0         | 0          |

`botcenter_outbound_send_delay_seconds` (all runs, 14978 sends): average 37 ms, 94 % below 100 ms, 99.9 % below 1 s, maximum below 2 s. All 14978 messages became `sent` and then `delivered`. No message failed.

| Memory (RSS) | Start  | After `RATE=50` | After `RATE=150` | End    |
| ------------ | ------ | --------------- | ---------------- | ------ |
| API          | 185 MB | 314 MB          | 323 MB           | 323 MB |
| Worker       | 224 MB | 341 MB          | 350 MB           | 350 MB |

The memory stopped its growth after the first run. The API stays below its container limit (512 MB), and the worker stays below its limit (1 GB).

### Analysis

- The architecture target (p95 below 150 ms for the 202 answer at 50 requests per second, errors below 1 %) passes. The margin is small (128 ms). The median is 20 ms; the tail comes from the API, the worker, PostgreSQL, Redis, and k6 on one machine with other stacks.
- At 150 requests per second, the p95 is 209 ms. One API process uses one CPU core; each `POST /v1/messages` does the key check, the rate limit script, the idempotency row, the quota, the insert, and the enqueue. For more than about 100 requests per second, start a second API process behind Caddy.
- The worker keeps up with the API at both rates: the outbound queue never had a waiting job. The send rate limit of each instance (600 per minute) is the limit for one number, not the worker.
- The worker counts an expected race as a failure. The fake server sends the `delivered` webhook within milliseconds, before the worker writes the provider id. The `message.status` handler then throws `StatusTargetNotReadyError` and the inbound job retries (plan, section 8, messages). In the runs, 1493 of 31509 inbound jobs (4.7 %) had such a retry. Each one is a `warn` log line and `botcenter_jobs_total{queue="inbound",result="failed"}`. No status was lost. Real Evolution sends the status later, so the count is lower in production, but a dashboard or an alert on that counter shows false failures.
- The memory for each connected WhatsApp number cannot be measured with the fake server. `README.md`, section "Measure the memory for each connected instance", has the procedure with real test numbers.
