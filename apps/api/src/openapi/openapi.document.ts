import type { INestApplicationContext } from '@nestjs/common';
import { HTTP_CODE_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ProblemDetails } from '@botcenter/contracts';
import { z } from 'zod';
import { isZodDto } from '../common/zod-dto';
import { API_OPERATION, API_RESPONSES } from './openapi.decorators';
import type { ApiOperationOptions, ApiResponseEntry } from './openapi.decorators';
import { listRoutes } from './routes';
import type { RouteInfo } from './routes';

/**
 * Builds the OpenAPI 3.1 document from the Nest route metadata and the Zod schemas
 * (`z.toJSONSchema`, JSON Schema 2020-12, the dialect of OpenAPI 3.1). A route appears without extra
 * work; `@ApiOperation` and `@ApiResponse` add the summary and the response bodies. Routes with
 * `@Internal()` are not in the document.
 */
export const OPENAPI_INFO = {
  title: 'Bot Center API',
  version: '0.1.0',
  description:
    'Gateway and bot engine in front of the WhatsApp provider. Errors are RFC 9457 Problem Details ' +
    '(`application/problem+json`) with a stable `code`. Write requests accept `Idempotency-Key`.',
};

type JsonSchema = Record<string, unknown>;

interface Components {
  schemas: Record<string, JsonSchema>;
}

const PROBLEM_REF = { $ref: '#/components/schemas/ProblemDetails' };

function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  }) as JsonSchema;
  delete json['$schema'];
  return json;
}

/** Adds a named component once. Request DTOs use the input shape, responses the output shape. */
function register(components: Components, name: string, schema: z.ZodType, io: 'input' | 'output') {
  components.schemas[name] ??= toJsonSchema(schema, io);
  return { $ref: `#/components/schemas/${name}` };
}

interface ArgMetadata {
  index: number;
  data?: unknown;
}

function routeArgs(route: RouteInfo): { type: RouteParamtypes; metatype: unknown }[] {
  const args =
    (Reflect.getMetadata(ROUTE_ARGS_METADATA, route.controller, route.methodName) as
      Record<string, ArgMetadata> | undefined) ?? {};
  const paramTypes =
    (Reflect.getMetadata(
      'design:paramtypes',
      route.controller.prototype as object,
      route.methodName,
    ) as unknown[] | undefined) ?? [];
  return Object.entries(args).flatMap(([key, meta]) => {
    const type = Number(key.split(':')[0]);
    if (Number.isNaN(type)) {
      return [];
    }
    return [{ type: type as RouteParamtypes, metatype: paramTypes[meta.index] }];
  });
}

function parametersOf(schema: z.ZodType, location: 'query' | 'path'): JsonSchema[] {
  const json = toJsonSchema(schema, 'input');
  const properties = (json['properties'] as Record<string, JsonSchema> | undefined) ?? {};
  const required = new Set((json['required'] as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: location,
    required: location === 'path' || required.has(name),
    schema: property,
  }));
}

function problemResponse(description: string) {
  return { description, content: { 'application/problem+json': { schema: PROBLEM_REF } } };
}

function defaultTag(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return (segments[0] === 'v1' ? segments[1] : segments[0]) ?? 'default';
}

function buildOperation(route: RouteInfo, components: Components): JsonSchema {
  const operation = Reflect.getMetadata(API_OPERATION, route.handler) as
    ApiOperationOptions | undefined;
  const responses = [
    ...((Reflect.getMetadata(API_RESPONSES, route.handler) as ApiResponseEntry[] | undefined) ??
      []),
  ];
  const parameters: JsonSchema[] = [];
  let requestBody: JsonSchema | undefined;

  for (const arg of routeArgs(route)) {
    if (!isZodDto(arg.metatype)) {
      continue;
    }
    if (arg.type === RouteParamtypes.BODY) {
      requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: register(components, arg.metatype.name, arg.metatype.schema, 'input'),
          },
        },
      };
    } else if (arg.type === RouteParamtypes.QUERY) {
      parameters.push(...parametersOf(arg.metatype.schema, 'query'));
    } else if (arg.type === RouteParamtypes.PARAM) {
      parameters.push(...parametersOf(arg.metatype.schema, 'path'));
    }
  }

  const writes =
    ['POST', 'PUT', 'DELETE'].includes(route.httpMethod) && route.path.startsWith('/v1/');
  if (writes) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description: 'The same key with the same request returns the stored response for 24 h.',
      schema: { type: 'string', minLength: 1, maxLength: 255 },
    });
  }

  const successStatus =
    (Reflect.getMetadata(HTTP_CODE_METADATA, route.handler) as number | undefined) ??
    (route.httpMethod === 'POST' ? 201 : 200);
  if (responses.length === 0) {
    responses.push({ status: successStatus, description: 'Success' });
  }

  const responseMap: Record<string, JsonSchema> = {};
  for (const response of responses.sort((a, b) => a.status - b.status)) {
    const entry: JsonSchema = { description: response.description };
    if (response.schema) {
      const name = isZodDto(response.schema)
        ? (response.schema as { name: string }).name
        : response.schema.name;
      entry['content'] = {
        [response.contentType ?? 'application/json']: {
          schema: register(components, name, response.schema.schema, 'output'),
        },
      };
    }
    if (response.headers) {
      entry['headers'] = Object.fromEntries(
        Object.entries(response.headers).map(([header, description]) => [
          header,
          { description, schema: { type: 'string' } },
        ]),
      );
    }
    responseMap[String(response.status)] = entry;
  }
  if (requestBody || parameters.some((parameter) => parameter['in'] !== 'header')) {
    responseMap['400'] ??= problemResponse('The request is not valid (`VALIDATION_FAILED`)');
  }

  const result: JsonSchema = {
    operationId: `${route.controller.name.replace(/Controller$/, '')}_${route.methodName}`,
    tags: operation?.tags ?? [defaultTag(route.path)],
  };
  if (operation?.summary) {
    result['summary'] = operation.summary;
  }
  if (operation?.description) {
    result['description'] = operation.description;
  }

  if (route.policy?.kind === 'scopes') {
    result['security'] = [{ apiKey: [] }];
    result['x-required-scopes'] = route.policy.scopes;
    responseMap['401'] ??= problemResponse('Missing or invalid API key (`UNAUTHENTICATED`)');
    responseMap['403'] ??= problemResponse(
      'Scope or instance not allowed (`SCOPE_MISSING`, `INSTANCE_NOT_ALLOWED`)',
    );
    responseMap['429'] ??= {
      ...problemResponse('Rate limit of the API key (`RATE_LIMITED`)'),
      headers: {
        'Retry-After': { schema: { type: 'integer' } },
        'RateLimit-Limit': { schema: { type: 'integer' } },
        'RateLimit-Remaining': { schema: { type: 'integer' } },
      },
    };
    if (writes) {
      responseMap['409'] ??= problemResponse(
        'Idempotency conflict (`IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`) or state conflict',
      );
    }
  } else if (route.policy?.kind === 'connect_token') {
    result['security'] = [];
    responseMap['401'] ??= problemResponse('Invalid connect token (`CONNECT_TOKEN_INVALID`)');
  } else {
    result['security'] = [];
  }
  responseMap['default'] = problemResponse('Error (Problem Details)');

  if (parameters.length > 0) {
    result['parameters'] = parameters;
  }
  if (requestBody) {
    result['requestBody'] = requestBody;
  }
  result['responses'] = Object.fromEntries(
    Object.entries(responseMap).sort(([a], [b]) => a.localeCompare(b)),
  );
  return result;
}

/** Converts `/v1/messages/:id` to `/v1/messages/{id}`. */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

export function buildOpenApiDocument(app: INestApplicationContext): JsonSchema {
  const components: Components = { schemas: {} };
  components.schemas['ProblemDetails'] = toJsonSchema(ProblemDetails, 'output');
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const route of listRoutes(app)) {
    if (!route.policy || route.policy.kind === 'internal') {
      continue;
    }
    const path = toOpenApiPath(route.path);
    paths[path] ??= {};
    paths[path][route.httpMethod.toLowerCase()] = buildOperation(route, components);
  }
  return {
    openapi: '3.1.0',
    info: OPENAPI_INFO,
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    servers: [{ url: '/' }],
    security: [{ apiKey: [] }],
    paths,
    components: {
      schemas: Object.fromEntries(
        Object.entries(components.schemas).sort(([a], [b]) => a.localeCompare(b)),
      ),
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'API key: `Authorization: Bearer bc_live_<prefix>_<secret>`.',
        },
      },
    },
  };
}
