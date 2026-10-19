import { Global, Module } from '@nestjs/common';
import { ApiKeyService } from '../auth/api-key.service';
import { ConfigModule } from '../config/config.module';
import { MetricsModule } from '../metrics/metrics.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProviderModule } from '../provider/provider.module';
import { QueuesService } from '../queues/queues.service';
import { QuotaService } from '../rate-limit/quota.service';
import { RedisModule } from '../redis/redis.module';
import { AlertService } from '../services/alert.service';
import { AuditService } from '../services/audit.service';
import { DistributedLockService } from '../services/lock.service';
import { OutboxService } from '../services/outbox.service';
import { SecretBox } from '../services/secret-box';
import { TenantsService } from '../services/tenants.service';

const SERVICES = [
  AlertService,
  AuditService,
  TenantsService,
  OutboxService,
  DistributedLockService,
  SecretBox,
  QuotaService,
  ApiKeyService,
  QueuesService,
];

/**
 * The shared core of both processes (API and worker). Every provider is global: a feature module injects
 * `PrismaService`, `REDIS`, `MetricsService`, `WHATSAPP_PROVIDER`, `PROVIDER_WEBHOOK_NORMALIZER`, `ENV`,
 * and the services below without an import.
 */
@Global()
@Module({
  imports: [ConfigModule, PrismaModule, RedisModule, MetricsModule, ProviderModule],
  providers: SERVICES,
  exports: SERVICES,
})
export class CoreModule {}
