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
| `WHATSAPP_PROVIDER`, `PROVIDER_WEBHOOK_NORMALIZER` | The provider pair (`@botcenter/whatsapp-provider` types)                                       |
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

## Tests

- Unit tests: `src/**/*.spec.ts`. Use `testEnv()` from `test/support/env.ts` for a valid environment.
- Integration tests: `test/int/**/*.int.spec.ts` with `TestHarness` from `test/support/harness.ts`. One harness for each file starts PostgreSQL 16 and Redis 7 (random ports), applies the migrations, and builds the API with `FakeWhatsAppProvider`, `FakeWebhookNormalizer`, and a recording `AlertService` (`h.alerts`). Helpers: `h.createTenant()`, `h.createApiKey()`, `h.createInstance()`, `h.inject()`, `h.bearer(key)`, `h.internalHeaders()`, `h.startWorker(modules)`.
