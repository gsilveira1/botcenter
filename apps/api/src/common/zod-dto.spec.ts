import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from './errors/app-error';
import { ZodValidationPipe, createZodDto, isZodDto, parseOrThrow } from './zod-dto';

class Body extends createZodDto(
  z.object({ to: z.string().min(1), count: z.coerce.number().int().default(1) }),
) {}

describe('Zod DTOs', () => {
  it('marks a DTO class and keeps its name for OpenAPI', () => {
    expect(isZodDto(Body)).toBe(true);
    expect(Body.name).toBe('Body');
    expect(isZodDto(String)).toBe(false);
  });

  it('the pipe parses a DTO argument and leaves other arguments as they are', () => {
    const pipe = new ZodValidationPipe();
    expect(pipe.transform({ to: 'x', count: '2' }, { type: 'body', metatype: Body })).toEqual({
      to: 'x',
      count: 2,
    });
    expect(pipe.transform('raw', { type: 'body', metatype: String })).toBe('raw');
  });

  it('the pipe throws VALIDATION_FAILED with field errors and the query prefix', () => {
    const pipe = new ZodValidationPipe();
    try {
      pipe.transform({ to: '' }, { type: 'query', metatype: Body });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('VALIDATION_FAILED');
      expect((error as AppError).errors).toEqual([
        { path: 'query.to', message: expect.any(String) },
      ]);
    }
  });

  it('parseOrThrow gives the parsed value', () => {
    expect(parseOrThrow(z.object({ a: z.string() }), { a: 'b' })).toEqual({ a: 'b' });
    expect(() => parseOrThrow(z.string(), 1)).toThrow(AppError);
  });
});
