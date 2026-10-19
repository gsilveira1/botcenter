import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../openapi/openapi.document';
import { listRoutes } from '../openapi/routes';
import { WebhookDeliveriesService } from './webhook-deliveries.service';
import { WebhookSubscriptionsService } from './webhook-subscriptions.service';
import { WebhooksController } from './webhooks.controller';

// The document is plain JSON; the test reads nested fields without a schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/**
 * `apps/api/openapi.json` comes from `AppModule`, which only the orchestrator edits. Until the wiring,
 * this test checks the OpenAPI entries and the access policy of every webhook route.
 */
describe('webhook routes in the OpenAPI document', () => {
  async function build() {
    const moduleRef = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        { provide: WebhookSubscriptionsService, useValue: {} },
        { provide: WebhookDeliveriesService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    return moduleRef;
  }

  it('gives every route the events:read scope, a summary, and its success response', async () => {
    const moduleRef = await build();
    try {
      const routes = listRoutes(moduleRef).map((route) => `${route.httpMethod} ${route.path}`);
      expect(routes.sort()).toEqual(
        [
          'DELETE /v1/webhooks/:id',
          'GET /v1/webhooks',
          'GET /v1/webhooks/deliveries',
          'POST /v1/webhooks',
          'POST /v1/webhooks/:id/rotate-secret',
          'POST /v1/webhooks/deliveries/:id/redeliver',
        ].sort(),
      );
      const doc = buildOpenApiDocument(moduleRef) as Doc;
      const expected: [string, string, string][] = [
        ['/v1/webhooks', 'post', '201'],
        ['/v1/webhooks', 'get', '200'],
        ['/v1/webhooks/deliveries', 'get', '200'],
        ['/v1/webhooks/deliveries/{id}/redeliver', 'post', '202'],
        ['/v1/webhooks/{id}', 'delete', '204'],
        ['/v1/webhooks/{id}/rotate-secret', 'post', '200'],
      ];
      for (const [path, method, status] of expected) {
        const operation = doc['paths'][path][method];
        expect(operation['x-required-scopes']).toEqual(['events:read']);
        expect(operation.summary).toEqual(expect.any(String));
        expect(operation.responses[status]).toBeDefined();
      }
      expect(doc['components'].schemas.WebhookCreatedResponseDto.properties.secret).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });

  it('documents no Idempotency-Key for the routes that return a secret', async () => {
    const moduleRef = await build();
    try {
      const doc = buildOpenApiDocument(moduleRef) as Doc;
      const names = (operation: Doc) =>
        ((operation['parameters'] ?? []) as { name: string }[]).map((parameter) => parameter.name);
      expect(names(doc['paths']['/v1/webhooks'].post)).not.toContain('Idempotency-Key');
      expect(names(doc['paths']['/v1/webhooks/{id}/rotate-secret'].post)).not.toContain(
        'Idempotency-Key',
      );
      expect(names(doc['paths']['/v1/webhooks/{id}'].delete)).toContain('Idempotency-Key');
    } finally {
      await moduleRef.close();
    }
  });
});
