import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Type } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Scope } from '@botcenter/contracts';
import { EvolutionWebhookNormalizer } from '@botcenter/whatsapp-provider';
import type { WhatsAppProvider } from '@botcenter/whatsapp-provider';
import { FakeEvolutionServer, FakeWhatsAppProvider } from '@botcenter/whatsapp-provider/testing';
import type { FakeEvolutionServerOptions } from '@botcenter/whatsapp-provider/testing';
import { Redis } from 'ioredis';
import { AppModule } from '../../src/app.module';
import { generateApiKey, hashSecret } from '../../src/auth/api-key';
import { configureApp, createFastifyAdapter } from '../../src/bootstrap';
import { ENV, loadEnv } from '../../src/config/env';
import type { AppEnv } from '../../src/config/env';
import { PrismaClient } from '../../src/generated/prisma/client';
import type { Instance, Tenant } from '../../src/generated/prisma/client';
import { PROVIDER_BINDINGS, WHATSAPP_PROVIDER } from '../../src/provider/provider.tokens';
import type { ProviderBindings } from '../../src/provider/provider.tokens';
import { AlertService } from '../../src/services/alert.service';
import { WorkerModule } from '../../src/worker.module';
import { startContainers, startMinio } from './containers';
import type { TestContainers, TestMinio } from './containers';
import { RecordingAlertService } from './recording-alerts';

/** The shared secret of the internal provider webhook in tests. */
export const TEST_WEBHOOK_SECRET = 'test-webhook-secret-0123456789abcdef';
export const TEST_PEPPER = 'test-pepper-0123456789abcdef0123456789';
/** The Evolution API key of the tests (also the key of the fake Evolution server). */
export const TEST_EVOLUTION_KEY = 'test-evolution-key';
/** The path of the internal provider webhook. */
export const PROVIDER_WEBHOOK_PATH = '/internal/evolution/webhook';

/** The options of `fastify.inject` as the Nest Fastify adapter types them. */
export type InjectOptions = Exclude<
  Parameters<NestFastifyApplication['inject']>[0],
  string | undefined
>;

/** The response of `h.inject()`. `json()` is loose on purpose: tests read any field. */
export interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): any;
}

export interface HarnessOptions {
  /** Feature modules next to `AppModule` (wave 2 slices, before the orchestrator wires them). */
  modules?: Type[];
  /** Extra controllers (test probes). */
  controllers?: Type[];
  /** Extra environment values. */
  env?: Record<string, string>;
  /** More overrides on the testing module (for example a provider of a slice). */
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  /**
   * Run the app against a `FakeEvolutionServer` over HTTP: the real `providerFactory` binds the real
   * `EvolutionProvider` (`h.whatsapp`) to the fake server (`h.evolution`), and the app listens on
   * `127.0.0.1` (`h.baseUrl`), so the fake server can post webhooks to `h.webhookUrl`. Without this
   * option, the app uses the in-memory `FakeWhatsAppProvider` (`h.provider`) and `h.inject()` only.
   */
  fakeEvolution?: boolean | Omit<FakeEvolutionServerOptions, 'apiKey'>;
  /** Start MinIO with one private bucket and point the `S3_*` environment to it (`h.minio`). */
  minio?: boolean;
}

export interface CreatedApiKey {
  /** The full key: `Authorization: Bearer <key>`. */
  key: string;
  id: string;
  prefix: string;
}

export interface ApiKeyFixture {
  tenantId: string;
  scopes: Scope[];
  instanceIds?: string[];
  allowedIps?: string[];
  rateLimitPerMinute?: number | null;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}

/** Reserves a free TCP port on the loopback address for the app in the `fakeEvolution` mode. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The parts of a started harness. */
interface HarnessParts {
  containers: TestContainers;
  env: AppEnv;
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  prisma: PrismaClient;
  redis: Redis;
  alertService: RecordingAlertService;
  options: HarnessOptions;
  /** The in-memory pair (default mode). Undefined in the `fakeEvolution` mode. */
  fakeBindings?: ProviderBindings;
  /** The fake Evolution server (`fakeEvolution` mode). */
  evolution?: FakeEvolutionServer;
  /** MinIO (`minio` option). */
  minio?: TestMinio;
}

/**
 * The integration test harness. One harness for each test file:
 *
 *   let h: TestHarness;
 *   beforeAll(async () => { h = await TestHarness.start({ modules: [MessagesApiModule] }); });
 *   afterAll(async () => { await h.close(); });
 *
 *   const tenant = await h.createTenant();
 *   const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['messages:send'] });
 *   const response = await h.inject({ method: 'GET', url: '/v1/...', headers: h.bearer(key) });
 *
 * It starts PostgreSQL 16 and Redis 7 (Testcontainers), applies the migrations, and builds the API with
 * a recording `AlertService` (`h.alerts`) and the real `EvolutionWebhookNormalizer`. The provider is the
 * in-memory `FakeWhatsAppProvider` (`h.provider`), or, with `{ fakeEvolution: true }`, the real
 * `EvolutionProvider` against a `FakeEvolutionServer` over HTTP (`h.evolution`, `h.whatsapp`).
 * `h.startWorker()` builds the worker process (queue consumers) against the same containers.
 */
export class TestHarness {
  readonly containers: TestContainers;
  readonly env: AppEnv;
  readonly app: NestFastifyApplication;
  readonly moduleRef: TestingModule;
  /** A separate Prisma client for fixtures and assertions. */
  readonly prisma: PrismaClient;
  /** A separate Redis client for assertions. */
  readonly redis: Redis;
  readonly alertService: RecordingAlertService;
  private readonly options: HarnessOptions;
  private readonly fakeBindings: ProviderBindings | undefined;
  private readonly fakeEvolution: FakeEvolutionServer | undefined;
  private readonly testMinio: TestMinio | undefined;
  private workers: TestingModule[] = [];

  private constructor(parts: HarnessParts) {
    this.containers = parts.containers;
    this.env = parts.env;
    this.app = parts.app;
    this.moduleRef = parts.moduleRef;
    this.prisma = parts.prisma;
    this.redis = parts.redis;
    this.alertService = parts.alertService;
    this.options = parts.options;
    this.fakeBindings = parts.fakeBindings;
    this.fakeEvolution = parts.evolution;
    this.testMinio = parts.minio;
  }

  static async start(options: HarnessOptions = {}): Promise<TestHarness> {
    const [containers, minio] = await Promise.all([
      startContainers(),
      options.minio ? startMinio() : Promise.resolve(undefined),
    ]);
    const evolution = options.fakeEvolution
      ? await FakeEvolutionServer.start({
          ...(options.fakeEvolution === true ? {} : options.fakeEvolution),
          apiKey: TEST_EVOLUTION_KEY,
        })
      : undefined;
    const port = evolution ? await freePort() : undefined;
    const env = loadEnv({
      NODE_ENV: 'test',
      ROLE: 'api',
      LOG_LEVEL: process.env['TEST_LOG_LEVEL'] ?? 'silent',
      DATABASE_URL: containers.databaseUrl,
      DATABASE_POOL_SIZE: '5',
      REDIS_URL: containers.redisUrl,
      API_KEY_PEPPER: TEST_PEPPER,
      DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      EVOLUTION_URL: evolution?.url ?? 'http://evolution.test:8080',
      EVOLUTION_API_KEY: TEST_EVOLUTION_KEY,
      EVOLUTION_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
      INTERNAL_WEBHOOK_BASE_URL: port ? `http://127.0.0.1:${port}` : 'http://api.test:3000',
      S3_ENDPOINT: 'http://minio.test:9000',
      S3_BUCKET: 'test',
      S3_ACCESS_KEY_ID: 'test',
      S3_SECRET_ACCESS_KEY: 'test-secret',
      ...minio?.env,
      ...options.env,
    });
    // The fake pair has no `close`: the harness owns it, and the API and the worker share it.
    const fakeBindings: ProviderBindings | undefined = evolution
      ? undefined
      : { provider: new FakeWhatsAppProvider(), normalizer: new EvolutionWebhookNormalizer() };
    const alertService = new RecordingAlertService(env);

    let builder = Test.createTestingModule({
      imports: [AppModule, ...(options.modules ?? [])],
      controllers: options.controllers ?? [],
    });
    builder = TestHarness.applyOverrides(builder, env, fakeBindings, alertService, options);
    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env), {
      logger: false,
      bodyParser: false,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    if (port) {
      await app.listen({ port, host: '127.0.0.1' });
    }

    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: containers.databaseUrl }),
    });
    const redis = new Redis(containers.redisUrl, { maxRetriesPerRequest: 1 });
    return new TestHarness({
      containers,
      env,
      app,
      moduleRef,
      prisma,
      redis,
      alertService,
      options,
      ...(fakeBindings ? { fakeBindings } : {}),
      ...(evolution ? { evolution } : {}),
      ...(minio ? { minio } : {}),
    });
  }

  /**
   * Replaces `ENV` and `AlertService`, and the provider pair when the harness owns a fake pair. In the
   * `fakeEvolution` mode, the real `providerFactory` builds the pair (one for each process).
   */
  private static applyOverrides(
    builder: TestingModuleBuilder,
    env: AppEnv,
    fakeBindings: ProviderBindings | undefined,
    alerts: RecordingAlertService,
    options: HarnessOptions,
  ): TestingModuleBuilder {
    let base = builder
      .overrideProvider(ENV)
      .useValue(env)
      .overrideProvider(AlertService)
      .useValue(alerts);
    if (fakeBindings) {
      base = base.overrideProvider(PROVIDER_BINDINGS).useValue(fakeBindings);
    }
    return options.override ? options.override(base) : base;
  }

  /** The alerts that the application sent. */
  get alerts() {
    return this.alertService.alerts;
  }

  /** The in-memory provider of the default mode. It throws in the `fakeEvolution` mode. */
  get provider(): FakeWhatsAppProvider {
    if (!this.fakeBindings) {
      throw new Error(
        'h.provider exists only without fakeEvolution: use h.evolution and h.whatsapp',
      );
    }
    return this.fakeBindings.provider as FakeWhatsAppProvider;
  }

  /** The fake Evolution server of the `fakeEvolution` mode. It throws in the default mode. */
  get evolution(): FakeEvolutionServer {
    if (!this.fakeEvolution) {
      throw new Error('h.evolution exists only with TestHarness.start({ fakeEvolution: true })');
    }
    return this.fakeEvolution;
  }

  /** The provider that the API process uses (`WHATSAPP_PROVIDER`), in both modes. */
  get whatsapp(): WhatsAppProvider {
    return this.app.get<WhatsAppProvider>(WHATSAPP_PROVIDER);
  }

  /** MinIO of the `minio` option. It throws without the option. */
  get minio(): TestMinio {
    if (!this.testMinio) {
      throw new Error('h.minio exists only with TestHarness.start({ minio: true })');
    }
    return this.testMinio;
  }

  /** The URL of the app on the loopback address (`fakeEvolution` mode only). */
  get baseUrl(): string {
    if (!this.fakeEvolution) {
      throw new Error('h.baseUrl exists only with fakeEvolution: the default mode does not listen');
    }
    return this.env.INTERNAL_WEBHOOK_BASE_URL;
  }

  /** The provider webhook URL for `createInstance` (`<INTERNAL_WEBHOOK_BASE_URL>/internal/evolution/webhook`). */
  get webhookUrl(): string {
    return `${this.env.INTERNAL_WEBHOOK_BASE_URL}${PROVIDER_WEBHOOK_PATH}`;
  }

  inject(options: InjectOptions): Promise<InjectResponse> {
    return this.app.inject(options) as unknown as Promise<InjectResponse>;
  }

  bearer(key: string): Record<string, string> {
    return { authorization: `Bearer ${key}` };
  }

  /** The headers of a call to the internal provider webhook. */
  internalHeaders(secret = TEST_WEBHOOK_SECRET): Record<string, string> {
    return { 'x-botcenter-webhook-secret': secret, 'content-type': 'application/json' };
  }

  /** Posts a provider webhook body (for example `evolutionInboundText(...).body`) with the right secret. */
  postProviderWebhook(body: unknown, headers = this.internalHeaders()): Promise<InjectResponse> {
    return this.inject({
      method: 'POST',
      url: PROVIDER_WEBHOOK_PATH,
      headers,
      payload: JSON.stringify(body),
    });
  }

  get<T>(token: Type<T> | symbol | string): T {
    return this.app.get(token as Type<T>);
  }

  /**
   * Starts the worker process (`WorkerModule` + `modules`) against the same containers, with the same
   * fakes. The workers start in `onApplicationBootstrap`. `close()` stops them.
   */
  /**
   * Builds a worker process. `root` replaces the root module, for example to test the core without the
   * handlers of the feature slices.
   */
  async startWorker(modules: Type[] = [], root: Type = WorkerModule): Promise<TestingModule> {
    const env = { ...this.env, ROLE: 'worker' as const };
    let builder = Test.createTestingModule({ imports: [root, ...modules] });
    builder = TestHarness.applyOverrides(
      builder,
      env,
      this.fakeBindings,
      this.alertService,
      this.options,
    );
    const worker = await builder.compile();
    await worker.init();
    this.workers.push(worker);
    return worker;
  }

  async createTenant(overrides: Partial<Tenant> = {}): Promise<Tenant> {
    const suffix = randomUUID().slice(0, 8);
    return this.prisma.tenant.create({
      data: { name: `Tenant ${suffix}`, slug: `tenant-${suffix}`, ...overrides },
    });
  }

  async createApiKey(fixture: ApiKeyFixture): Promise<CreatedApiKey> {
    const generated = generateApiKey();
    const row = await this.prisma.apiKey.create({
      data: {
        tenantId: fixture.tenantId,
        name: 'test key',
        prefix: generated.prefix,
        secretHash: hashSecret(this.env.API_KEY_PEPPER, generated.secret),
        scopes: fixture.scopes,
        instanceIds: fixture.instanceIds ?? [],
        allowedIps: fixture.allowedIps ?? [],
        rateLimitPerMinute: fixture.rateLimitPerMinute ?? null,
        expiresAt: fixture.expiresAt ?? null,
        revokedAt: fixture.revokedAt ?? null,
      },
    });
    return { key: generated.key, id: row.id, prefix: row.prefix };
  }

  async createInstance(tenantId: string, overrides: Partial<Instance> = {}): Promise<Instance> {
    return this.prisma.instance.create({
      data: {
        tenantId,
        externalRef: `owner-${randomUUID()}`,
        providerName: `inst_${randomUUID()}`,
        consentAt: new Date(),
        rateLimitPerMinute: 20,
        ...overrides,
      },
    });
  }

  async close(): Promise<void> {
    for (const worker of this.workers.splice(0)) {
      await worker.close();
    }
    await this.app.close();
    await this.fakeEvolution?.close();
    await this.testMinio?.stop();
    await this.prisma.$disconnect();
    this.redis.disconnect();
    await this.containers.stop();
  }
}
