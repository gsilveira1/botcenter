# 0002. BullMQ on Redis for the queues

- Status: Accepted (2026-10-18)
- Source: architecture, sections "Componentes e tecnologias" and "Performance"; implementation plan, section 8

## Context

The sends and the received events have a high volume in short peaks. The client must get a 202 answer at once, and the workers do the slow work. The Evolution API already needs a Redis for its cache. pg-boss is good for scheduled jobs with a low volume.

## Decision

Use BullMQ 5 on Redis 7 for the queues `outbound`, `inbound`, `webhooks`, `timers`, and `maintenance`. The scheduled maintenance jobs also use BullMQ job schedulers (one queue system). Redis runs with AOF (`appendfsync everysec`) and `maxmemory-policy noeviction`. Bot Center uses Redis database 0; the Evolution cache uses database 1.

## Consequences

- One Redis serves the queues, the rate limits, the key cache, the locks, and the hot state of the conversations.
- A crash loses at most 1 second of queue writes (AOF everysec).
- A full Redis refuses writes instead of losing jobs. The memory of Redis must stay below its limit; the runbook has the procedure "Queue backlog".
- RabbitMQ stays an option for phase 3, if the metrics show lost events.
