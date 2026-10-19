import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../openapi/openapi.document';
import { listRoutes } from '../openapi/routes';
import { ConnectEventsController } from './connect-events.controller';
import { ConnectStreamService } from './connect-stream.service';
import { InstanceConnectService } from './instance-connect.service';
import { InstancesController } from './instances.controller';
import { InstancesService } from './instances.service';

// The document is plain JSON; the tests read nested fields without a schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/**
 * The orchestrator adds `InstancesApiModule` to `app.module.ts`, then `apps/api/openapi.json` gets these
 * routes. This test checks the entries of the slice before that.
 */
describe('instances routes in the OpenAPI document', () => {
  let doc: Doc;
  let routes: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InstancesController, ConnectEventsController],
      providers: [
        { provide: InstancesService, useValue: {} },
        { provide: InstanceConnectService, useValue: {} },
        { provide: ConnectStreamService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    doc = buildOpenApiDocument(moduleRef) as Doc;
    routes = listRoutes(moduleRef).map((route) => `${route.httpMethod} ${route.path}`);
    await moduleRef.close();
  });

  it('has every route of the slice with an access policy', () => {
    expect(routes.sort()).toEqual([
      'DELETE /v1/instances/:id',
      'GET /v1/connect/:token/events',
      'GET /v1/instances',
      'GET /v1/instances/:id',
      'POST /v1/instances',
      'POST /v1/instances/:id/connect',
    ]);
    for (const [path, methods] of Object.entries(doc['paths'] as Doc)) {
      for (const [method, operation] of Object.entries(methods as Doc)) {
        expect(operation.security, `${method} ${path}`).toBeDefined();
      }
    }
  });

  it('documents the create answers 201 and 200 and the instances:manage scope', () => {
    const create = doc['paths']['/v1/instances'].post;
    expect(create['x-required-scopes']).toEqual(['instances:manage']);
    expect(Object.keys(create.responses)).toEqual(
      expect.arrayContaining(['200', '201', '400', '401', '403', '409', '429']),
    );
    expect(create.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CreateInstanceBody',
    });
    expect(create.parameters).toEqual([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header' }),
    ]);
  });

  it('documents the connect answers: a token (201) or the connected status (200)', () => {
    const connect = doc['paths']['/v1/instances/{id}/connect'].post;
    expect(connect.responses['201'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/ConnectInstanceResponseDto',
    );
    expect(connect.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/ConnectInstanceConnectedResponseDto',
    );
    expect(
      doc['components'].schemas.ConnectInstanceBody.oneOf ??
        doc['components'].schemas.ConnectInstanceBody.anyOf,
    ).toHaveLength(2);
  });

  it('documents the list query and the event stream as text/event-stream without an API key', () => {
    const list = doc['paths']['/v1/instances'].get;
    expect(list.parameters.map((parameter: Doc) => parameter['name'])).toEqual([
      'cursor',
      'limit',
      'external_ref',
    ]);
    const events = doc['paths']['/v1/connect/{token}/events'].get;
    expect(events.security).toEqual([]);
    expect(events.tags).toEqual(['instances']);
    expect(events.responses['200'].content['text/event-stream'].schema.$ref).toBe(
      '#/components/schemas/ConnectEvent',
    );
    expect(events.responses['401']).toBeDefined();
  });
});
