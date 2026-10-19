import { Module } from '@nestjs/common';
import { CoreModule } from '../core/core.module';
import { ProviderInstancesService } from '../instances/provider-instances.service';
import { AdminOperationsService } from './admin-operations.service';
import { AdminService } from './admin.service';

/** Root module of the admin CLI (`dist/scripts/admin.js`). No HTTP server and no workers. */
@Module({
  imports: [CoreModule],
  providers: [AdminService, AdminOperationsService, ProviderInstancesService],
  exports: [AdminService],
})
export class AdminCliModule {}
