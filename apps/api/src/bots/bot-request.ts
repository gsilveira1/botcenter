import { BotDefinition, PutBotRequest } from '@botcenter/contracts';
import { z } from 'zod';

/** The JSON Schema of a bot definition for the OpenAPI document (request shape, with the defaults). */
function definitionJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(BotDefinition, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete schema['$schema'];
  return schema;
}

/**
 * The body of `PUT /v1/bots/{id}` for the global validation pipe. It is `PutBotRequest` of the contracts,
 * but the pipe does not validate `definition`: the service checks it with `parseDefinitionForEngine`
 * (contract schema and engine rules, RE2) and answers 422 `BOT_DEFINITION_INVALID` with one error for
 * each path. A missing `definition` is still a 400. The OpenAPI document shows the full definition schema.
 */
export const PutBotBodySchema = z
  .object({
    name: PutBotRequest.shape.name,
    definition: z
      .unknown()
      .refine((value) => value !== undefined, 'Required')
      .meta(definitionJsonSchema()),
    instance_ids: PutBotRequest.shape.instance_ids,
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.instance_ids.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['instance_ids', index],
          message: `Duplicate instance id "${id}"`,
        });
      }
      seen.add(id);
    });
  });
export type PutBotBody = z.infer<typeof PutBotBodySchema>;
