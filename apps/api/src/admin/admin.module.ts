import { Module } from '@nestjs/common';
import { CoreModule } from '../core/core.module';
import { AdminService } from './admin.service';

/** Root module of the admin CLI (`dist/scripts/admin.js`). No HTTP server and no workers. */
@Module({
  imports: [CoreModule],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminCliModule {}
