import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Type } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Scope } from '@botcenter/contracts';
import { Redis } from 'ioredis';
import { AppModule } from '../../src/app.module';
import { generateApiKey, hashSecret } from '../../src/auth/api-key';
import { configureApp, createFastifyAdapter } from '../../src/bootstrap';
import { ENV, loadEnv } from '../../src/config/env';
import type { AppEnv } from '../../src/config/env';
import { PrismaClient } from '../../src/generated/prisma/client';
import type { Instance, Tenant } from '../../src/generated/prisma/client';
import { PROVIDER_BINDINGS } from '../../src/provider/provider.tokens';
import { AlertService } from '../../src/services/alert.service';
import { WorkerModule } from '../../src/worker.module';
import { startContainers } from './containers';
import type { TestContainers } from './containers';
import { FakeWebhookNormalizer, FakeWhatsAppProvider } from './fake-provider';
import { RecordingAlertService } from './recording-alerts';

/** The shared secret of the internal provider webhook in tests. */
export const TEST_WEBHOOK_SECRET = 'test-webhook-secret-0123456789abcdef';
export const TEST_PEPPER = 'test-pepper-0123456789abcdef0123456789';

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
 * the fake provider (`h.provider`, `h.normalizer`) and a recording `AlertService` (`h.alerts`).
 * `h.startWorker()` builds the worker process (queue consumers) against the same containers.
 */
export class TestHarness {
  private workers: TestingModule[] = [];

  private constructor(
    readonly containers: TestContainers,
    readonly env: AppEnv,
    readonly app: NestFastifyApplication,
    readonly moduleRef: TestingModule,
    /** A separate Prisma client for fixtures and assertions. */
    readonly prisma: PrismaClient,
    /** A separate Redis client for assertions. */
    readonly redis: Redis,
    readonly provider: FakeWhatsAppProvider,
    readonly normalizer: FakeWebhookNormalizer,
    readonly alertService: RecordingAlertService,
    private readonly options: HarnessOptions,
  ) {}

  static async start(options: HarnessOptions = {}): Promise<TestHarness> {
    const containers = await startContainers();
    const env = loadEnv({
      NODE_ENV: 'test',
      ROLE: 'api',
      LOG_LEVEL: process.env['TEST_LOG_LEVEL'] ?? 'silent',
      DATABASE_URL: containers.databaseUrl,
      DATABASE_POOL_SIZE: '5',
      REDIS_URL: containers.redisUrl,
      API_KEY_PEPPER: TEST_PEPPER,
      DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      EVOLUTION_URL: 'http://evolution.test:8080',
      EVOLUTION_API_KEY: 'test-evolution-key',
      EVOLUTION_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
      INTERNAL_WEBHOOK_BASE_URL: 'http://api.test:3000',
      S3_ENDPOINT: 'http://minio.test:9000',
      S3_BUCKET: 'test',
      S3_ACCESS_KEY_ID: 'test',
      S3_SECRET_ACCESS_KEY: 'test-secret',
      ...options.env,
    });
    const provider = new FakeWhatsAppProvider();
    const normalizer = new FakeWebhookNormalizer();
    const alertService = new RecordingAlertService(env);

    let builder = Test.createTestingModule({
      imports: [AppModule, ...(options.modules ?? [])],
      controllers: options.controllers ?? [],
    });
    builder = TestHarness.applyOverrides(builder, env, provider, normalizer, alertService, options);
    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env), {
      logger: false,
      bodyParser: false,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: containers.databaseUrl }),
    });
    const redis = new Redis(containers.redisUrl, { maxRetriesPerRequest: 1 });
    return new TestHarness(
      containers,
      env,
      app,
      moduleRef,
      prisma,
      redis,
      provider,
      normalizer,
      alertService,
      options,
    );
  }

  private static applyOverrides(
    builder: TestingModuleBuilder,
    env: AppEnv,
    provider: FakeWhatsAppProvider,
    normalizer: FakeWebhookNormalizer,
    alerts: RecordingAlertService,
    options: HarnessOptions,
  ): TestingModuleBuilder {
    const base = builder
      .overrideProvider(ENV)
      .useValue(env)
      .overrideProvider(PROVIDER_BINDINGS)
      .useValue({ provider, normalizer })
      .overrideProvider(AlertService)
      .useValue(alerts);
    return options.override ? options.override(base) : base;
  }

  /** The alerts that the application sent. */
  get alerts() {
    return this.alertService.alerts;
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

  get<T>(token: Type<T> | symbol | string): T {
    return this.app.get(token as Type<T>);
  }

  /**
   * Starts the worker process (`WorkerModule` + `modules`) against the same containers, with the same
   * fakes. The workers start in `onApplicationBootstrap`. `close()` stops them.
   */
  async startWorker(modules: Type[] = []): Promise<TestingModule> {
    const env = { ...this.env, ROLE: 'worker' as const };
    let builder = Test.createTestingModule({ imports: [WorkerModule, ...modules] });
    builder = TestHarness.applyOverrides(
      builder,
      env,
      this.provider,
      this.normalizer,
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
    await this.prisma.$disconnect();
    this.redis.disconnect();
    await this.containers.stop();
  }
}
