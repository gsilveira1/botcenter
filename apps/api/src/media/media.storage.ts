import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import {
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';

/** DI token of the S3 client (R2 in production, MinIO in local runs and tests). */
export const S3_CLIENT = Symbol('S3_CLIENT');

export function createS3Client(env: AppEnv): S3Client {
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
}

export interface StoredObject {
  sizeBytes: number;
  contentType: string | undefined;
}

/**
 * The private media bucket (`S3_BUCKET`). No object is public: a client uploads with a pre-signed `PUT`
 * URL, and the provider downloads with a short-lived pre-signed `GET` URL. A signature is a local
 * computation; only `head` calls the storage.
 */
@Injectable()
export class MediaStorage implements OnApplicationShutdown {
  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  /**
   * A `PUT` URL that signs the content type and the size. The client must send the same
   * `Content-Type` and exactly `sizeBytes` bytes, or the storage refuses the upload.
   */
  uploadUrl(
    key: string,
    contentType: string,
    sizeBytes: number,
    ttlSeconds: number,
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.env.S3_BUCKET,
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
    });
    return getSignedUrl(this.s3, command, {
      expiresIn: ttlSeconds,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
  }

  /** Writes an object from the worker (inbound media of the conversations slice). */
  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: key,
        Body: data,
        ContentType: contentType,
        ContentLength: data.length,
      }),
    );
  }

  downloadUrl(key: string, ttlSeconds: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key });
    return getSignedUrl(this.s3, command, { expiresIn: ttlSeconds });
  }

  /** The size and the type of an object, or `null` when the object does not exist. */
  async head(key: string): Promise<StoredObject | null> {
    try {
      const result = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }),
      );
      return { sizeBytes: result.ContentLength ?? 0, contentType: result.ContentType };
    } catch (error) {
      if (error instanceof NotFound || (error as Error).name === 'NotFound') {
        return null;
      }
      throw error;
    }
  }

  onApplicationShutdown(): void {
    this.s3.destroy();
  }
}
