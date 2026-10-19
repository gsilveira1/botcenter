# @botcenter/api

The NestJS 11 application of Bot Center on Fastify. One build, two processes:

| Process | Entry            | `ROLE`   | Root module        | Content                                                                                    |
| ------- | ---------------- | -------- | ------------------ | ------------------------------------------------------------------------------------------ |
| API     | `dist/main.js`   | `api`    | `app.module.ts`    | HTTP routes, the global guard, the internal provider webhook, `/health/*`, `/metrics`      |
| Worker  | `dist/worker.js` | `worker` | `worker.module.ts` | BullMQ consumers, the inbound handler registry, `/metrics` on `WORKER_METRICS_PORT` (9464) |

Only the orchestrator edits `app.module.ts`, `worker.module.ts`, and `src/provider/provider.factory.ts`.

## Commands

```sh
pnpm --filter @botcenter/api build        # tsc to dist/
pnpm --filter @botcenter/api test         # unit tests (src/**/*.spec.ts)
pnpm --filter @botcenter/api test:int     # integration tests (Docker: PostgreSQL 16 + Redis 7)
pnpm --filter @botcenter/api openapi      # writes apps/api/openapi.json
pnpm --filter @botcenter/api admin:key:create -- --tenant personallife --name backend --scopes messages:send
```

The admin scripts run from `dist` (`node dist/scripts/admin.js <command>`). Run `node dist/scripts/admin.js --help` for the commands. Each command writes an audit row and prints JSON. `key:create` and `key:rotate` print the full key one time.

Container memory: set `NODE_OPTIONS=--max-old-space-size=384` for the API (512 MB limit) and `--max-old-space-size=768` for the worker (1 GB limit).

## Core services

Every provider of `CoreModule` is global in both processes. Inject it without an import.

| Provider                                           | Use                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ENV` (`AppEnv`)                                   | The validated environment (`src/config/env.ts`)                                                |
| `PrismaService`                                    | Prisma 7 client. Use `forTenant(tenantId)` for tenant tables: it adds the `tenantId` filter    |
| `REDIS`                                            | The shared `ioredis` client (request path, commands fail after 2 s)                            |
| `MetricsService`                                   | The Prometheus registry and the shared metrics (`botcenter_*`)                                 |
| `WHATSAPP_PROVIDER`, `PROVIDER_WEBHOOK_NORMALIZER` | `EvolutionProvider` and `EvolutionWebhookNormalizer` (`src/provider/provider.factory.ts`)      |
| `AlertService`                                     | `notify({ severity, title, details, dedupeKey })`. Never throws                                |
| `AuditService`                                     | `record(entry, tx?)`. Insert only                                                              |
| `TenantsService`                                   | `get(tenantId)` with the quotas (60 s cache), `invalidate(tenantId)`                           |
| `OutboxService`                                    | `enqueue(tx, { tenantId, type, payload })` in the transaction of the state change              |
| `QuotaService`                                     | Fixed-window counters (`minute`, `day`): the daily message quota                               |
| `DistributedLockService`                           | `withLock(name, { ttlMs, waitMs }, fn)`: the lock for each conversation                        |
| `SecretBox`                                        | AES-256-GCM `encrypt(text, aad?)` and `decrypt(sealed, aad?)`                                  |
| `QueuesService`                                    | `add(queue, jobName, payload, options)`. Queue names and payloads: `src/queues/queue-names.ts` |

API process only: `ConnectTokenVerifierRegistry`, `RateLimitService`. Worker process only: `WorkerFactory`, `InboundHandlerRegistry`.

## Add a module

1. Make a directory `src/<slice>/`.
2. Export one module for each process that needs it:
   - `<Slice>ApiModule` with the controllers and the services of the routes.
   - `<Slice>WorkerModule` with the queue consumers and the inbound handlers.
3. Do not import `CoreModule`: its providers are global.
4. Give the orchestrator the module names. The orchestrator adds them to `app.module.ts` and `worker.module.ts`.
5. In tests, load the module with the harness: `TestHarness.start({ modules: [MessagesApiModule] })`.

## Add a route

```ts
class SendMessageBody extends createZodDto(SendMessageRequest) {}
class MessageParams extends createZodDto(UuidParam) {}
class MessageResponseDto extends createZodDto(MessageResponse) {}

@Controller('v1/messages')
export class MessagesController {
  @Post()
  @HttpCode(202)
  @RequireScope('messages:send')
  @ApiOperation({ summary: 'Queue a message' })
  @ApiResponse(202, { description: 'Queued', schema: MessageResponseDto })
  send(@Auth() auth: AuthContext, @Body() body: SendMessageBody) {
    assertInstanceAllowed(auth, body.instance_id);
    // ...
  }
}
```

- Every route needs one access decorator: `@RequireScope(...)`, `@ConnectToken()`, `@Internal()`, or `@Public()`. The guard refuses a route without one, and a unit test lists every route.
- `@Body()`, `@Query()`, and `@Param()` with a `createZodDto` class are validated by the global pipe. A failure is 400 `VALIDATION_FAILED` with `errors`.
- Throw `AppError(code, detail)` with a code of `ErrorCode`. The filter writes Problem Details. Do not put a phone number or message content in `detail`.
- `POST`, `PUT`, and `DELETE` under `/v1` get `Idempotency-Key` from the global interceptor. Use `@SkipIdempotency()` for a response that must not be stored.
- A list uses `keysetArgs(query)` and `toPage(rows, query.limit, map)` from `src/common/pagination/cursor.ts`.
- Call `assertInstanceAllowed(auth, instanceId)` before each action on an instance. Query with `prisma.forTenant(auth.tenantId)`: a resource of another tenant is not found.
- A connect token route: register a `ConnectTokenVerifier` in `onModuleInit` with `ConnectTokenVerifierRegistry.register(this)`.

## Add an OpenAPI entry

The generator reads the routes, the Zod DTO classes, and the access decorators. Add `@ApiOperation` and one `@ApiResponse` for each success status. A response schema is a `createZodDto` class or `{ name, schema }`. Then run `pnpm --filter @botcenter/api openapi` and commit `apps/api/openapi.json`. A unit test fails when the file is not current. `@Internal()` routes are not in the document.

## Add a queue handler

```ts
@Injectable()
export class OutboundWorker implements OnApplicationBootstrap {
  constructor(private readonly workers: WorkerFactory) {}

  onApplicationBootstrap(): void {
    this.workers.create('outbound', (job) => this.send(job));
  }
}
```

- `WorkerFactory.create` sets the concurrency from `WORKER_CONCURRENCY_<QUEUE>`, the log context (`queue`, `job_id`, `tenant_id`, `instance_id`), the job metrics, and an alert when the last attempt fails.
- Throw to retry with the backoff of the queue (`DEFAULT_JOB_OPTIONS` in `queues.service.ts`). Throw `UnrecoverableError` to fail at once. Catch only the errors that you expect.
- A job must be idempotent. Use a deterministic `jobId` when a duplicate job is possible.
- Add a new payload type to `JobPayloads` in `queue-names.ts` (additive edit).

## Add an inbound handler

```ts
@Injectable()
export class MessageStatusHandler implements InboundHandler<'message.status'>, OnModuleInit {
  constructor(private readonly registry: InboundHandlerRegistry) {}

  onModuleInit(): void {
    this.registry.register('message.status', this);
  }

  async handle(
    event: ProviderEventOf<'message.status'>,
    context: InboundJobContext,
  ): Promise<void> {
    // ...
  }
}
```

- One handler for each `ProviderEventKind`. A second registration stops the start.
- An event without a handler is logged at `warn`, counted, and the job ends.
- The inbound worker does not order the events of a conversation. Use `DistributedLockService` in the handler.

## Call a client URL

Inject `EXTERNAL_HTTP` (the frozen port, `ExternalHttpPort.postJson`) for a URL that a client supplies. `ExternalHttpModule` is global and comes with `WebhooksApiModule` and `WebhooksWorkerModule`.

- The SSRF guard resolves the host one time, refuses the URL when one address is private, loopback, link-local, CGNAT, multicast, reserved, IPv4-mapped to one of these, or a cloud metadata address, and the connection uses only the checked addresses (no DNS rebinding).
- HTTPS only when `NODE_ENV=production`. No redirects (a 3xx is a normal response). The time limit is at most 30 s. The response limit is `EXTERNAL_HTTP_MAX_RESPONSE_BYTES`. The `User-Agent` is fixed.
- The port throws `ExternalHttpError` only (`forbidden_address`, `timeout`, `network`, `response_too_large`).
- Tests: replace `DNS_RESOLVER` with `fakeDns()` from `test/support/webhooks.ts`. Set `EXTERNAL_HTTP_ALLOW_PRIVATE=true` (refused in production) to call a local receiver (`TestReceiver` in `test/support/receiver.ts`).

## Add an inbound sweep task

The `sweep-inbound` job of the `inbound` queue (every minute) repairs lost inbound work. Register an `InboundSweepTask` (`name`, `run(now)`) with `InboundHandlerRegistry.registerSweep(this)` in `onModuleInit`. `run` must be idempotent and safe when two runs overlap. A failed task does not stop the other tasks. The conversations slice registers `drain-pending-inbound` and `repair-state-timers`.

## Add a maintenance task

Register a `MaintenanceTask` (`name`, `everyMs`, `run(now)`) with `MaintenanceTaskRegistry.register(this)` in `onModuleInit`. Add the name to `MaintenanceJob['task']` in `queue-names.ts`. The maintenance worker upserts one BullMQ job scheduler for each task (the scheduler id is the task name) and removes the schedulers of old tasks. `run` must be idempotent and safe when two runs overlap. Use `BatchPurger.deleteWhere` for deletes (batches with `FOR UPDATE SKIP LOCKED`) and `IncidentService.update` for an alert with a recovery message.

## Tests

- Unit tests: `src/**/*.spec.ts`. Use `testEnv()` from `test/support/env.ts` for a valid environment.
- Integration tests: `test/int/**/*.int.spec.ts` with `TestHarness` from `test/support/harness.ts`. One harness for each file starts PostgreSQL 16 and Redis 7 (random ports), applies the migrations, and builds the API with the real `EvolutionWebhookNormalizer` and a recording `AlertService` (`h.alerts`). Helpers: `h.createTenant()`, `h.createApiKey()`, `h.createInstance()`, `h.inject()`, `h.bearer(key)`, `h.internalHeaders()`, `h.postProviderWebhook(body)`, `h.startWorker(modules)`, and `waitFor(check)` from `test/support/wait-for.ts`.
- Default mode: the provider is the in-memory `FakeWhatsAppProvider` of `@botcenter/whatsapp-provider/testing` (`h.provider`: `sent`, `calls`, `failNext(method, code)`, `setState`). The API process and the worker process share it. Make the webhook bodies with `evolutionInboundText()` and `evolutionStatus()` from `test/support/fake-provider.ts`. Each one returns the real Evolution body and the `dedupeKey` of its event:

  ```ts
  const webhook = evolutionInboundText({ instanceName: instance.providerName, text: 'Oi' });
  const response = await h.postProviderWebhook(webhook.body); // 200 { received: 1, enqueued: 1 }
  const job = await h.get(QueuesService).get('inbound').getJob(inboundJobId(webhook.dedupeKey));
  ```

- Object storage: `TestHarness.start({ minio: true })` starts MinIO with one private bucket and points the `S3_*` environment to it (`h.minio.endpoint`, `h.minio.bucket`).
- HTTP mode: `TestHarness.start({ fakeEvolution: true })` starts a `FakeEvolutionServer` (`h.evolution`). The real `providerFactory` binds the real `EvolutionProvider` (`h.whatsapp`) to it, and the app listens on `127.0.0.1` (`h.baseUrl`). `h.provider` throws in this mode.

  ```ts
  await h.whatsapp.createInstance({
    name,
    webhookUrl: h.webhookUrl,
    webhookSecret: h.env.EVOLUTION_WEBHOOK_SECRET,
  });
  await h.evolution.emitConnected(name, '5511912345678'); // the fake server posts the webhook to the app
  await h.evolution.emitInboundText(name, { from: '5511987654321', text: 'Oi' });
  ```
