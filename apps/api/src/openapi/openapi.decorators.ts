import { SetMetadata } from '@nestjs/common';
import type { z } from 'zod';
import type { ZodDto } from '../common/zod-dto';

export const API_OPERATION = 'botcenter:openapi-operation';
export const API_RESPONSES = 'botcenter:openapi-responses';

export interface ApiOperationOptions {
  summary: string;
  description?: string;
  /** Default: the first segment of the path after `/v1` (for example `messages`). */
  tags?: string[];
}

export interface ApiResponseOptions {
  description: string;
  /** A Zod DTO class (its name is the component name) or a named Zod schema. Omit it for no body. */
  schema?: ZodDto | { name: string; schema: z.ZodType };
  /** Response headers, for example `{ Location: 'URL of the resource' }`. */
  headers?: Record<string, string>;
}

export interface ApiResponseEntry extends ApiResponseOptions {
  status: number;
}

/** Summary and tags of a route in the OpenAPI document. */
export const ApiOperation = (options: ApiOperationOptions) => SetMetadata(API_OPERATION, options);

/**
 * One success response of a route. The generator adds the request body, the query, and the path
 * parameters from the Zod DTO types of `@Body()`, `@Query()`, and `@Param()`, and the error responses
 * (Problem Details) from the access policy. Repeat the decorator for several statuses.
 */
export function ApiResponse(status: number, options: ApiResponseOptions): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    const existing =
      (Reflect.getMetadata(API_RESPONSES, descriptor.value as object) as
        ApiResponseEntry[] | undefined) ?? [];
    Reflect.defineMetadata(
      API_RESPONSES,
      [...existing, { status, ...options }],
      descriptor.value as object,
    );
    return descriptor;
  };
}
