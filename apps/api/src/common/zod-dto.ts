import { Injectable } from '@nestjs/common';
import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { ProblemFieldError } from '@botcenter/contracts';
import type { z } from 'zod';
import { validationError } from './errors/app-error';

/**
 * Zod DTOs. A DTO class carries its Zod schema, so that one declaration gives the validation (the global
 * `ZodValidationPipe`), the TypeScript type, and the OpenAPI schema (the class name is the component name).
 *
 *   export class SendMessageBody extends createZodDto(SendMessageRequest) {}
 *   send(@Body() body: SendMessageBody) { ... }
 */
export interface ZodDto<T extends z.ZodType = z.ZodType> {
  new (): z.output<T>;
  readonly schema: T;
  readonly isZodDto: true;
}

export function createZodDto<T extends z.ZodType>(schema: T): ZodDto<T> {
  class ZodDtoBase {
    static readonly schema = schema;
    static readonly isZodDto = true as const;
  }
  return ZodDtoBase as unknown as ZodDto<T>;
}

export function isZodDto(value: unknown): value is ZodDto {
  return (
    typeof value === 'function' &&
    (value as Partial<ZodDto>).isZodDto === true &&
    (value as Partial<ZodDto>).schema !== undefined
  );
}

/** Converts Zod issues to the `errors` member of a Problem Details document. */
export function toFieldErrors(
  issues: readonly z.core.$ZodIssue[],
  prefix?: string,
): ProblemFieldError[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return {
      path: prefix ? (path ? `${prefix}.${path}` : prefix) : path,
      message: issue.message,
    };
  });
}

/** Parses `value` with `schema`, or throws 400 `VALIDATION_FAILED` with the field errors. */
export function parseOrThrow<T extends z.ZodType>(
  schema: T,
  value: unknown,
  prefix?: string,
): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw validationError('The request is not valid', toFieldErrors(result.error.issues, prefix));
  }
  return result.data;
}

const PREFIX_BY_TYPE: Partial<Record<ArgumentMetadata['type'], string>> = {
  query: 'query',
  param: 'params',
};

/** Global pipe: validates each `@Body()`, `@Query()`, and `@Param()` whose type is a Zod DTO. */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (!isZodDto(metadata.metatype)) {
      return value;
    }
    return parseOrThrow(metadata.metatype.schema, value, PREFIX_BY_TYPE[metadata.type]);
  }
}
