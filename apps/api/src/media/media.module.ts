import { Module } from '@nestjs/common';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';
import { ExternalHttpModule } from '../external-http/external-http.module';
import { MediaUrlFetcher } from './media-url.fetcher';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaStorage, S3_CLIENT, createS3Client } from './media.storage';

/**
 * The S3 client, the storage, the media service, and the download of client media URLs. Both processes
 * import it. `ExternalHttpModule` gives the SSRF guard and `EXTERNAL_HTTP_BINARY`.
 */
@Module({
  imports: [ExternalHttpModule],
  providers: [
    { provide: S3_CLIENT, inject: [ENV], useFactory: (env: AppEnv) => createS3Client(env) },
    MediaStorage,
    MediaService,
    MediaUrlFetcher,
  ],
  exports: [MediaStorage, MediaService, MediaUrlFetcher],
})
export class MediaModule {}

/** API process: `POST /v1/media`. */
@Module({
  imports: [MediaModule],
  controllers: [MediaController],
})
export class MediaApiModule {}
