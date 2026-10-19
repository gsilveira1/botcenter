/** Placeholder environment of the OpenAPI export (no connection opens) and the file format. */
export const OPENAPI_PLACEHOLDER_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://openapi:openapi@localhost:5432/openapi',
  REDIS_URL: 'redis://localhost:6379/0',
  API_KEY_PEPPER: 'openapi-export-placeholder-pepper-0000',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  EVOLUTION_URL: 'http://localhost:8080',
  EVOLUTION_API_KEY: 'openapi',
  EVOLUTION_WEBHOOK_SECRET: 'openapi-export-placeholder-secret-0000',
  INTERNAL_WEBHOOK_BASE_URL: 'http://localhost:3000',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'openapi',
  S3_ACCESS_KEY_ID: 'openapi',
  S3_SECRET_ACCESS_KEY: 'openapi',
};

export function serializeDocument(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
