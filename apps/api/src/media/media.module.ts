import { Module } from '@nestjs/common';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaStorage, S3_CLIENT, createS3Client } from './media.storage';

/** The S3 client, the storage, and the media service. Both processes import it. */
@Module({
  providers: [
    { provide: S3_CLIENT, inject: [ENV], useFactory: (env: AppEnv) => createS3Client(env) },
    MediaStorage,
    MediaService,
  ],
  exports: [MediaStorage, MediaService],
})
export class MediaModule {}

/** API process: `POST /v1/media`. */
@Module({
  imports: [MediaModule],
  controllers: [MediaController],
})
export class MediaApiModule {}
