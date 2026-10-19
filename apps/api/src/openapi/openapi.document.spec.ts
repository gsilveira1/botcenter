import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CursorQuery, UuidParam } from '@botcenter/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testEnv } from '../../test/support/env';
import { AppModule } from '../app.module';
import { Internal, Public, RequireScope } from '../auth/decorators';
import { createZodDto } from '../common/zod-dto';
import { ENV } from '../config/env';
import { buildOpenApiDocument, toOpenApiPath } from './openapi.document';
import { serializeDocument } from './openapi-export';
import { ApiOperation, ApiResponse } from './openapi.decorators';
import { listRoutes } from './routes';

class CreateThingBody extends createZodDto(
  z.object({ name: z.string().min(1), size: z.number().int().optional() }),
) {}
class ThingParams extends createZodDto(UuidParam) {}
class ThingQuery extends createZodDto(CursorQuery) {}
class ThingResponse extends createZodDto(
  z.object({ id: z.uuid(), name: z.string(), created_at: z.iso.datetime() }),
) {}

@Controller('v1/things')
class ThingsController {
  @Post()
  @HttpCode(202)
  @RequireScope('bots:write')
  @ApiOperation({ summary: 'Create a thing' })
  @ApiResponse(202, { description: 'Accepted', schema: ThingResponse })
  create(@Body() _body: CreateThingBody) {}

  @Get(':id')
  @RequireScope('bots:write')
  read(@Param() _params: ThingParams, @Query() _query: ThingQuery) {}

  @Delete(':id')
  @Public()
  remove() {}

  @Post('hook')
  @Internal()
  hook() {}
}

// The document is plain JSON; the tests read nested fields without a schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

describe('buildOpenApiDocument', () => {
  let doc: Doc;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ThingsController] }).compile();
    await moduleRef.init();
    doc = buildOpenApiDocument(moduleRef) as Doc;
    await moduleRef.close();
  });

  it('writes an OpenAPI 3.1 document with the bearer scheme and the Problem Details component', () => {
    expect(doc['openapi']).toBe('3.1.0');
    expect(doc['components'].securitySchemes.apiKey).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(doc['components'].schemas.ProblemDetails.properties.code.enum).toContain('RATE_LIMITED');
  });

  it('reads the body, the responses, the scopes, and the idempotency header of a write route', () => {
    const operation = doc['paths']['/v1/things'].post;
    expect(operation.summary).toBe('Create a thing');
    expect(operation.tags).toEqual(['things']);
    expect(operation['x-required-scopes']).toEqual(['bots:write']);
    expect(operation.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CreateThingBody',
    });
    expect(doc['components'].schemas.CreateThingBody.required).toEqual(['name']);
    expect(operation.responses['202'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ThingResponse',
    });
    expect(Object.keys(operation.responses)).toEqual([
      '202',
      '400',
      '401',
      '403',
      '409',
      '429',
      'default',
    ]);
    expect(operation.parameters).toEqual([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: false }),
    ]);
  });

  it('reads the path and query parameters and converts the path template', () => {
    const operation = doc['paths']['/v1/things/{id}'].get;
    expect(operation.parameters).toEqual([
      expect.objectContaining({ name: 'cursor', in: 'query', required: false }),
      expect.objectContaining({ name: 'limit', in: 'query', required: false }),
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    ]);
    expect(operation.responses['200']).toEqual({ description: 'Success' });
    expect(toOpenApiPath('/v1/a/:id/b/:other_id')).toBe('/v1/a/{id}/b/{other_id}');
  });

  it('marks a public route without security and leaves internal routes out', () => {
    expect(doc['paths']['/v1/things/{id}'].delete.security).toEqual([]);
    expect(doc['paths']['/v1/things/hook']).toBeUndefined();
  });
});

describe('application routes', () => {
  it('every route has an access policy, and apps/api/openapi.json is current', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue(testEnv())
      .compile();
    // An application context is enough: the route metadata does not need an HTTP adapter.
    const app = await moduleRef.init();
    try {
      const routes = listRoutes(app);
      expect(routes.map((route) => `${route.httpMethod} ${route.path}`)).toEqual(
        expect.arrayContaining([
          'GET /health/live',
          'GET /health/ready',
          'POST /internal/evolution/webhook',
        ]),
      );
      // SEC-01: /metrics is on the API metrics listener (API_METRICS_PORT), not on the HTTP port.
      expect(routes.map((route) => `${route.httpMethod} ${route.path}`)).not.toContain(
        'GET /metrics',
      );
      const withoutPolicy = routes
        .filter((route) => !route.policy)
        .map((route) => `${route.httpMethod} ${route.path}`);
      expect(withoutPolicy).toEqual([]);

      const committed = readFileSync(path.resolve(__dirname, '..', '..', 'openapi.json'), 'utf8');
      // When this fails, run `pnpm --filter @botcenter/api openapi` and commit apps/api/openapi.json.
      expect(serializeDocument(buildOpenApiDocument(app))).toBe(committed);
    } finally {
      await app.close();
    }
  });
});
