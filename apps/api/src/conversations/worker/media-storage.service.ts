import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ENV } from '../../config/env';
import type { AppEnv } from '../../config/env';

/**
 * The S3 media bucket (Cloudflare R2 in production, MinIO in local runs and tests) for inbound media.
 * Follow-up for the orchestrator: the messages slice has its own S3 client for uploads; merge the two
 * into one core storage service after wave 2.
 */
@Injectable()
export class MediaStorageService implements OnApplicationShutdown {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(@Inject(ENV) env: AppEnv) {
    this.bucket = env.S3_BUCKET;
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }),
    );
  }

  /** A signed GET URL of the object. The URL works without credentials until it expires. */
  async signedGetUrl(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
